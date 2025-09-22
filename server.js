const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

//Connect with mysql on railway.com
const db = mysql.createConnection({
  host: "caboose.proxy.rlwy.net", // Lấy host từ MYSQL_URL
  user: "root", // Tên người dùng
  password: "OjpGMNFrqNcvAirdacMUROPhDKZVuBc", // Mật khẩu
  database: "railway", // Tên database
  port: 26637, // Cổng từ MYSQL_URL
  connectTimeout: 60000,
  acquireTimeout: 60000,
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

// Main API endpoint cho Chatfuel
app.post("/scholarships", (req, res) => {
  console.log("📨 Nhận request từ Chatfuel:", req.body);

  const {
    eligible_location,
    jlpt_min_level, // user's JLPT (e.g. "N2")
    eju_min_total, // user's EJU (e.g. "600" or "600+")
    education_min, // user's education (e.g. "high_school_graduate")
    age_max, // user's age (e.g. "21")
  } = req.body;

  // Validate dữ liệu đầu vào
  if (!eligible_location || eligible_location === "unknown") {
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
  if (eligible_location && eligible_location !== "none") {
    whereConditions.push(
      "(eligible_location = ? OR eligible_location = 'any' OR eligible_location IS NULL)"
    );
    queryParams.push(eligible_location);
  }

  // Helper trong JS (nếu muốn convert user level to number)
  function jlptToNumber(level) {
    const map = { N5: 1, N4: 2, N3: 3, N2: 4, N1: 5 };
    return map[level] || 0;
  }

  // 2. Lọc theo JLPT (cho phép user có level cao hơn pož yêu cầu)
  if (jlpt_min_level && jlpt_min_level !== "none") {
    const userJlptNum = jlptToNumber(jlpt_min_level);
    if (userJlptNum > 0) {
      whereConditions.push(`(
      jlpt_min_level IS NULL OR
      CASE jlpt_min_level
        WHEN 'N5' THEN 1
        WHEN 'N4' THEN 2
        WHEN 'N3' THEN 3
        WHEN 'N2' THEN 4
        WHEN 'N1' THEN 5
        ELSE 0
      END <= ?
    )`);
      queryParams.push(userJlptNum);
    }
  }

  // 3. Lọc theo EJU score
  if (eju_min_total && eju_min_total !== "none") {
    if (userEjuScore > 0) {
      whereConditions.push("(eju_min_total IS NULL OR eju_min_total <= ?)");
      queryParams.push(userEjuScore);
    }
  }

  // 4. Lọc theo trình độ học vấn
  if (education_min && education_min !== "none") {
    whereConditions.push("(education_min IS NULL OR education_min = ?)");
    queryParams.push(education_min);
  }

  // 5. Lọc theo tuổi
  if (age_max && age_max !== "none") {
    whereConditions.push("(age_max IS NULL OR age_max >= ?)");
    queryParams.push(Number(age_max));
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
${
  jlpt_min_level === "none" || !jlpt_min_level
    ? "• Hãy thi JLPT (ít nhất N3)"
    : ""
}
${
  eju_min_total === "none" || !eju_min_total
    ? "• Thi EJU để có thêm cơ hội"
    : ""
}
${eju_min_total === "500" ? "• Cải thiện điểm EJU lên trên 550+" : ""}

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

