const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Database connection với error handling tốt
const db = mysql.createConnection({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "Viha0701",
  database: process.env.DB_NAME || "scholarship_conditions",
  connectTimeout: 60000,
  acquireTimeout: 60000,
  timeout: 60000,
});

// Test connection with retry
function connectWithRetry() {
  db.connect((err) => {
    if (err) {
      console.log("Lỗi kết nối database, thử lại sau 5s:", err.message);
      setTimeout(connectWithRetry, 5000);
    } else {
      console.log("✅ Kết nối database thành công!");
    }
  });
}

connectWithRetry();

// Helper function: Convert JLPT level to number for comparison
function jlptToNumber(level) {
  const levels = { N5: 1, N4: 2, N3: 3, N2: 4, N1: 5 };
  return levels[level] || 0;
}

// Helper function: Convert EJU score string to number
function ejuScoreToNumber(scoreStr) {
  if (!scoreStr || scoreStr === "none") return 0;

  const scoreMap = {
    "700+": 700,
    "650+": 650,
    "600+": 600,
    "550+": 550,
    "500+": 500,
    below_500: 400,
  };

  return scoreMap[scoreStr] || 0;
}

// Main API endpoint cho Chatfuel
app.post("/scholarships", (req, res) => {
  console.log("📨 Nhận request từ Chatfuel:", req.body);

  const {
    user_status,
    jlpt_level,
    eju_score,
    education,
    age_range,
    financial_need,
    exam_status,
  } = req.body;

  // Validate dữ liệu đầu vào
  if (!user_status || user_status === "unknown") {
    return res.json({
      messages: [
        {
          text: "❌ Thiếu thông tin cơ bản. Vui lòng bắt đầu lại cuộc trò chuyện!",
        },
      ],
    });
  }

  // Xây dựng điều kiện query
  let whereConditions = [];
  let queryParams = [];

  // 1. Lọc theo vị trí địa lý
  if (user_status === "vietnam") {
    whereConditions.push(
      "(eligible_location = ? OR eligible_location = ? OR eligible_location IS NULL)"
    );
    queryParams.push("vietnam", "any");
  } else if (
    user_status === "japan_language" ||
    user_status === "japan_university"
  ) {
    whereConditions.push(
      "(eligible_location = ? OR eligible_location = ? OR eligible_location IS NULL)"
    );
    queryParams.push("japan", "any");
  } else if (user_status === "government") {
    whereConditions.push(
      "(eligible_location = ? OR eligible_location = ? OR target_group LIKE ?)"
    );
    queryParams.push("vietnam", "any", "%government%");
  }

  // 2. Lọc theo JLPT level
  if (jlpt_level && jlpt_level !== "none") {
    const userJlptNumber = jlptToNumber(jlpt_level);
    whereConditions.push(`(jlpt_min_level IS NULL OR 
      CASE jlpt_min_level 
        WHEN 'N5' THEN 1 
        WHEN 'N4' THEN 2 
        WHEN 'N3' THEN 3 
        WHEN 'N2' THEN 4 
        WHEN 'N1' THEN 5 
        ELSE 0 
      END <= ?)`);
    queryParams.push(userJlptNumber);
  }

  // 3. Lọc theo EJU score
  if (eju_score && eju_score !== "none") {
    const userEjuScore = ejuScoreToNumber(eju_score);
    if (userEjuScore > 0) {
      whereConditions.push("(eju_min_total IS NULL OR eju_min_total <= ?)");
      queryParams.push(userEjuScore);
    }
  }

  // 4. Lọc theo trình độ học vấn
  if (education && education !== "unknown") {
    if (
      education === "high_school_current" ||
      education === "high_school_graduate"
    ) {
      whereConditions.push(
        "(target_group LIKE '%high school%' OR target_group LIKE '%undergraduate%' OR target_group IS NULL)"
      );
    } else if (
      education === "university_current" ||
      education === "university_graduate"
    ) {
      whereConditions.push(
        "(target_group LIKE '%undergraduate%' OR target_group LIKE '%graduate%' OR target_group IS NULL)"
      );
    } else if (education === "master_plus") {
      whereConditions.push(
        "(target_group LIKE '%graduate%' OR target_group LIKE '%postgraduate%' OR target_group IS NULL)"
      );
    }
  }

  // 5. Lọc theo nhu cầu tài chính
  if (financial_need === "full" || financial_need === "special") {
    whereConditions.push(
      '(monthly_stipend_yen_min > 100000 OR tuition_coverage = "full")'
    );
  } else if (financial_need === "partial") {
    whereConditions.push(
      '(monthly_stipend_yen_min > 50000 OR tuition_coverage IN ("partial", "full"))'
    );
  }

  // 6. Lọc theo tuổi (nếu có yêu cầu cụ thể)
  if (age_range && age_range !== "unknown") {
    // Hầu hết học bổng không có giới hạn tuổi nghiêm ngặt
    // Chỉ loại bỏ những cái có yêu cầu quá khắt khe
    if (age_range === "over_35") {
      whereConditions.push("(age_limit IS NULL OR age_limit >= 35)");
    }
  }

  // Tạo câu query hoàn chỉnh
  let query = `
    SELECT 
      scholarship_no,
      scholarship_name,
      monthly_stipend_yen_min,
      monthly_stipend_yen_max,
      tuition_coverage,
      application_window,
      interview_required,
      docs_required_core,
      official_link,
      special_notes,
      jlpt_min_level,
      eju_min_total
    FROM scholarship_conditions
  `;

  if (whereConditions.length > 0) {
    query += " WHERE " + whereConditions.join(" AND ");
  }

  // Sắp xếp theo mức hỗ trợ tài chính (ưu tiên cao nhất trước)
  query += ` 
    ORDER BY 
      monthly_stipend_yen_min DESC,
      CASE tuition_coverage WHEN 'full' THEN 3 WHEN 'partial' THEN 2 ELSE 1 END DESC
    LIMIT 5
  `;

  console.log("🔍 Query:", query);
  console.log("📋 Params:", queryParams);

  // Thực hiện query
  db.query(query, queryParams, (err, results) => {
    if (err) {
      console.error("❌ Database Error:", err);
      return res.json({
        messages: [
          { text: "⚠️ Có lỗi xảy ra khi tìm kiếm. Vui lòng thử lại sau!" },
        ],
      });
    }

    console.log(`✅ Tìm thấy ${results.length} học bổng`);

    if (results.length === 0) {
      return res.json({
        messages: [
          {
            text: `😔 Hiện tại chưa có học bổng hoàn toàn phù hợp với điều kiện của bạn.

💡 **Gợi ý cải thiện:**
${jlpt_level === "none" || !jlpt_level ? "• Hãy thi JLPT (ít nhất N3)" : ""}
${eju_score === "none" || !eju_score ? "• Thi EJU để có thêm cơ hội" : ""}
${eju_score === "below_500" ? "• Cải thiện điểm EJU lên trên 550+" : ""}

🔄 Hãy cập nhật thông tin và thử lại sau!`,
          },
        ],
      });
    }

    // Format kết quả cho Chatfuel
    const messages = [];

    // Message đầu tiên: Thông báo tìm thấy
    messages.push({
      text: `🎉 **Tìm thấy ${results.length} học bổng phù hợp!**\n\n📋 Dưới đây là các học bổng được sắp xếp theo mức độ ưu tiên:`,
    });

    // Các message tiếp theo: Chi tiết từng học bổng
    results.forEach((scholarship, index) => {
      let stipendInfo = "";

      if (scholarship.monthly_stipend_yen_min > 0) {
        const min = scholarship.monthly_stipend_yen_min.toLocaleString();
        const max =
          scholarship.monthly_stipend_yen_max >
          scholarship.monthly_stipend_yen_min
            ? scholarship.monthly_stipend_yen_max.toLocaleString()
            : min;
        stipendInfo = `💰 **${min}${max !== min ? `-${max}` : ""}** yen/tháng`;
      }

      let tuitionInfo = "";
      if (scholarship.tuition_coverage === "full") {
        tuitionInfo = "\n🎓 **Miễn phí** học phí";
      } else if (scholarship.tuition_coverage === "partial") {
        tuitionInfo = "\n🎓 **Hỗ trợ một phần** học phí";
      }

      let requirementInfo = "";
      if (scholarship.jlpt_min_level) {
        requirementInfo += `\n📝 JLPT: **${scholarship.jlpt_min_level}** trở lên`;
      }
      if (scholarship.eju_min_total > 0) {
        requirementInfo += `\n📊 EJU: **${scholarship.eju_min_total}+** điểm`;
      }

      const messageText = `**${index + 1}. ${
        scholarship.scholarship_name ||
        `Học bổng số ${scholarship.scholarship_no}`
      }**

${stipendInfo}${tuitionInfo}
⏰ **Đăng ký:** ${scholarship.application_window || "Liên hệ để biết thêm"}
${
  scholarship.interview_required === "yes"
    ? "🎤 **Có** phỏng vấn"
    : "✅ **Không** cần phỏng vấn"
}${requirementInfo}

📋 **Hồ sơ cần:** ${scholarship.docs_required_core || "Xem chi tiết tại link"}

${
  scholarship.special_notes
    ? `💡 **Lưu ý:** ${scholarship.special_notes}\n\n`
    : ""
}🔗 **Chi tiết:** ${scholarship.official_link || "Liên hệ để biết thêm"}

---`;

      messages.push({ text: messageText });
    });

    // Message cuối: Call to action
    messages.push({
      text: `✨ **Bước tiếp theo:**

1️⃣ Đọc kỹ yêu cầu của từng học bổng
2️⃣ Chuẩn bị hồ sơ theo danh sách
3️⃣ Nộp đơn trước deadline
4️⃣ Theo dõi email để biết kết quả

🍀 **Chúc bạn thành công!**

💬 Nhắn **"help"** nếu cần hỗ trợ thêm!`,
    });

    res.json({ messages });
  });
});

// Test endpoint để kiểm tra server
app.get("/", (req, res) => {
  res.json({
    status: "success",
    message: "Server đang hoạt động! Sẵn sàng nhận request từ Chatfuel.",
    timestamp: new Date().toISOString(),
    endpoints: {
      main: "POST /scholarships",
      test: "GET /test",
      health: "GET /",
    },
  });
});

// Test endpoint với dữ liệu mẫu
app.get("/test", (req, res) => {
  const testData = {
    user_status: "vietnam",
    jlpt_level: "N2",
    eju_score: "600+",
    education: "high_school_graduate",
    age_range: "20_25",
    financial_need: "full",
    exam_status: "both",
  };

  res.json({
    message: "Test data sẵn sàng",
    sample_request: testData,
    instructions: "POST dữ liệu này đến /scholarships để test",
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("💥 Server Error:", err);
  res.status(500).json({
    messages: [{ text: "⚠️ Có lỗi server. Vui lòng thử lại sau!" }],
  });
});

// Handle 404
app.use((req, res) => {
  res.status(404).json({
    error: "Endpoint không tồn tại",
    available_endpoints: ["GET /", "GET /test", "POST /scholarships"],
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại port ${PORT}`);
  console.log(
    `🌐 URL: ${
      process.env.NODE_ENV === "production"
        ? "https://your-app.herokuapp.com"
        : `http://localhost:${PORT}`
    }`
  );
});
