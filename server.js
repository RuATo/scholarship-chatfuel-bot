const express = require("express");
const mysql = require("mysql2/promise"); // Sử dụng promise version
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// BƯỚC 1: Cải thiện hàm createDatabaseConfig để hỗ trợ private network
function createDatabaseConfig() {
  // Debug environment variables
  console.log("🔍 Available Environment Variables:");
  console.log("DATABASE_URL:", process.env.DATABASE_URL ? "SET" : "NOT SET");
  console.log("MYSQL_URL:", process.env.MYSQL_URL ? "SET" : "NOT SET");
  console.log("MYSQL_PRIVATE_URL:", process.env.MYSQL_PRIVATE_URL ? "SET" : "NOT SET");
  console.log("DATABASE_PRIVATE_URL:", process.env.DATABASE_PRIVATE_URL ? "SET" : "NOT SET");
  
  // Ưu tiên sử dụng private URLs để tránh egress fees
  const databaseUrl = process.env.MYSQL_PRIVATE_URL || 
                     process.env.DATABASE_PRIVATE_URL || 
                     process.env.DATABASE_URL ||
                     process.env.MYSQL_URL;

  if (databaseUrl) {
    console.log("🔗 Using DATABASE_URL:", databaseUrl.replace(/:[^:]*@/, ':****@')); // Hide password
    
    const url = new URL(databaseUrl);
    
    // Railway private network thường không cần SSL
    const needSSL = url.hostname.includes('.railway.app') && !url.hostname.includes('.railway.internal');
    
    return {
      host: url.hostname,
      user: url.username,
      password: url.password,
      database: url.pathname.substring(1), // Remove leading '/'
      port: parseInt(url.port) || 3306,
      ssl: needSSL ? { rejectUnauthorized: false } : false,
      connectTimeout: 30000, // Giảm timeout
      acquireTimeout: 30000,
      timeout: 30000,
      reconnect: true,
      connectionLimit: 5, // Giảm connection pool
      queueLimit: 0
    };
  } else {
    // Fallback to individual environment variables
    console.log("🔗 Using individual environment variables");
    console.log("MYSQL_HOST:", process.env.MYSQL_HOST);
    console.log("MYSQL_PORT:", process.env.MYSQL_PORT);
    console.log("DB_HOST:", process.env.DB_HOST);
    
    return {
      host: process.env.MYSQL_HOST || process.env.DB_HOST,
      user: process.env.MYSQL_USER || process.env.DB_USER,
      password: process.env.MYSQL_PASSWORD || process.env.DB_PASS || process.env.DB_PASSWORD,
      database: process.env.MYSQL_DATABASE || process.env.DB_NAME,
      port: parseInt(process.env.MYSQL_PORT || process.env.DB_PORT) || 3306,
      ssl: false, // Private network không cần SSL
      connectTimeout: 30000,
      acquireTimeout: 30000,
      timeout: 30000,
      reconnect: true,
      connectionLimit: 5,
      queueLimit: 0
    };
  }
}

const dbConfig = createDatabaseConfig();

// Validate config before creating pool
if (!dbConfig.host || !dbConfig.user || !dbConfig.database) {
  console.error("❌ Missing required database configuration:");
  console.error("Host:", dbConfig.host || "MISSING");
  console.error("User:", dbConfig.user || "MISSING");
  console.error("Database:", dbConfig.database || "MISSING");
  process.exit(1);
}

const pool = mysql.createPool(dbConfig);

console.log("🔧 Database config:", {
  host: dbConfig.host,
  user: dbConfig.user,
  database: dbConfig.database,
  port: dbConfig.port,
  ssl: !!dbConfig.ssl
});

// BƯỚC 2: Cải thiện test connection function với better error handling
async function testConnection() {
  let connection;
  try {
    console.log(`🔄 Attempting to connect to ${dbConfig.host}:${dbConfig.port}...`);
    
    connection = await pool.getConnection();
    
    // Test với simple query
    const [rows] = await connection.execute('SELECT 1 as test');
    
    console.log("✅ Database connected successfully!");
    console.log(`🔗 Connected to: ${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);
    
    return true;
  } catch (error) {
    console.error("❌ Database connection failed:");
    console.error("Error code:", error.code);
    console.error("Error message:", error.message);
    console.error("Error errno:", error.errno);
    console.error("🔧 Config used:", {
      host: dbConfig.host,
      user: dbConfig.user,
      database: dbConfig.database,
      port: dbConfig.port,
      ssl: !!dbConfig.ssl
    });
    
    // Detailed error analysis
    if (error.code === 'ECONNREFUSED') {
      console.error("🚨 Connection refused - possible causes:");
      console.error("  1. Database service not running");
      console.error("  2. Wrong host/port configuration");
      console.error("  3. Firewall blocking connection");
      console.error("  4. Using public URL instead of private network");
    } else if (error.code === 'ER_ACCESS_DENIED_ERROR') {
      console.error("🚨 Access denied - check username/password");
    } else if (error.code === 'ENOTFOUND') {
      console.error("🚨 Host not found - check hostname");
    }
    
    return false;
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

// BƯỚC 3: Improved connection retry with exponential backoff
async function connectWithRetry(retries = 10) {
  for (let i = 0; i < retries; i++) {
    console.log(`🔄 Connection attempt ${i + 1}/${retries}`);
    
    const success = await testConnection();
    if (success) {
      console.log("🎉 Database connection established!");
      return true;
    }
    
    if (i < retries - 1) {
      const delay = Math.min(1000 * Math.pow(2, i), 30000); // Exponential backoff, max 30s
      console.log(`⏳ Retry in ${delay/1000} seconds...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  console.error("💥 Failed to connect after all retries");
  console.error("🔧 Please check:");
  console.error("  1. Railway MySQL service is running");
  console.error("  2. Environment variables are set correctly");
  console.error("  3. Using private network URL (MYSQL_PRIVATE_URL)");
  
  return false;
}

// Helper function để execute query an toàn
async function executeQuery(query, params = []) {
  let connection;
  try {
    connection = await pool.getConnection();
    const [results] = await connection.execute(query, params);
    return results;
  } catch (error) {
    console.error("❌ Query error:", error.message);
    console.error("🔍 Query:", query);
    console.error("📋 Params:", params);
    throw error;
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

// Main API endpoint với async/await
app.post("/scholarships", async (req, res) => {
  console.log("📨 Nhận request từ Chatfuel:", req.body);

  try {
    const {
      eligible_location,
      jlpt_min_level,
      eju_min_total,
      education_min,
      age_max,
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

    // Helper function
    function jlptToNumber(level) {
      const map = { N5: 1, N4: 2, N3: 3, N2: 4, N1: 5 };
      return map[level] || 0;
    }

    // 2. Lọc theo JLPT
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

    // 3. Lọc theo EJU score (Fix: thêm userEjuScore)
    if (eju_min_total && eju_min_total !== "none") {
      let userEjuScore = parseInt(eju_min_total.replace(/[+\s]/g, ''));
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

    query += ` 
      ORDER BY 
        monthly_stipend_yen_min DESC,
        CASE tuition_coverage WHEN 'full' THEN 3 WHEN 'partial' THEN 2 ELSE 1 END DESC
      LIMIT 5
    `;

    console.log("🔍 Query:", query);
    console.log("📋 Params:", queryParams);

    // Sử dụng executeQuery helper
    const results = await executeQuery(query, queryParams);

    console.log(`✅ Tìm thấy ${results.length} học bổng`);

    if (results.length === 0) {
      return res.json({
        messages: [
          {
            text: `😔 Hiện tại chưa có học bổng hoàn toàn phù hợp với điều kiện của bạn.

💡 **Gợi ý cải thiện:**
${jlpt_min_level === "none" || !jlpt_min_level ? "• Hãy thi JLPT (ít nhất N3)" : ""}
${eju_min_total === "none" || !eju_min_total ? "• Thi EJU để có thêm cơ hội" : ""}
${eju_min_total === "500" ? "• Cải thiện điểm EJU lên trên 550+" : ""}

🔄 Hãy cập nhật thông tin và thử lại sau!`,
          },
        ],
      });
    }

    // Format kết quả cho Chatfuel
    const messages = [];

    messages.push({
      text: `🎉 **Tìm thấy ${results.length} học bổng phù hợp!**\n\n📋 Dưới đây là các học bổng được sắp xếp theo mức độ ưu tiên:`,
    });

    results.forEach((scholarship, index) => {
      let stipendInfo = "";
      if (scholarship.monthly_stipend_yen_min > 0) {
        const min = scholarship.monthly_stipend_yen_min.toLocaleString();
        const max = scholarship.monthly_stipend_yen_max > scholarship.monthly_stipend_yen_min
          ? scholarship.monthly_stipend_yen_max.toLocaleString() : min;
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

      const messageText = `**${index + 1}. ${scholarship.scholarship_name || `Học bổng số ${scholarship.scholarship_no}`}**

${stipendInfo}${tuitionInfo}
⏰ **Đăng ký:** ${scholarship.application_window || "Liên hệ để biết thêm"}
${scholarship.interview_required === "yes" ? "🎤 **Có** phỏng vấn" : "✅ **Không** cần phỏng vấn"}${requirementInfo}

📋 **Hồ sơ cần:** ${scholarship.docs_required_core || "Xem chi tiết tại link"}

${scholarship.special_notes ? `💡 **Lưu ý:** ${scholarship.special_notes}\n\n` : ""}🔗 **Chi tiết:** ${scholarship.official_link || "Liên hệ để biết thêm"}

---`;

      messages.push({ text: messageText });
    });

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

  } catch (error) {
    console.error("❌ API Error:", error);
    return res.json({
      messages: [
        { text: "⚠️ Có lỗi xảy ra khi tìm kiếm. Vui lòng thử lại sau!" },
      ],
    });
  }
});

// Health check endpoint - Enhanced with better DB testing
app.get("/", async (req, res) => {
  try {
    // Test database connection
    await executeQuery("SELECT 1 as test");
    
    res.json({
      status: "success",
      message: "Server đang hoạt động! Sẵn sàng nhận request từ Chatfuel.",
      timestamp: new Date().toISOString(),
      database: "✅ Connected",
      config: {
        host: dbConfig.host,
        database: dbConfig.database,
        port: dbConfig.port,
        ssl: !!dbConfig.ssl
      },
      endpoints: {
        main: "POST /scholarships",
        test: "GET /test",
        health: "GET /",
      },
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: "❌ Database connection failed",
      error: error.message,
      timestamp: new Date().toISOString(),
      troubleshooting: {
        step1: "Check if MySQL service is running on Railway",
        step2: "Verify environment variables are set",
        step3: "Use MYSQL_PRIVATE_URL for private network",
        step4: "Check Railway project networking settings"
      }
    });
  }
});

// Test endpoint
app.get("/test", async (req, res) => {
  try {
    // Test database connection
    const testResult = await executeQuery("SELECT COUNT(*) as total FROM scholarship_conditions");
    
    const testData = {
      eligible_location: "vietnam",
      jlpt_min_level: "N2", 
      eju_min_total: "600",
      education_min: "high_school_graduate",
      age_max: "25",
    };

    res.json({
      message: "✅ Database connection OK",
      database_info: {
        host: dbConfig.host,
        database: dbConfig.database,
        total_scholarships: testResult[0].total
      },
      sample_request: testData,
      instructions: "POST dữ liệu này đến /scholarships để test",
    });
  } catch (error) {
    res.status(500).json({
      message: "❌ Database connection failed",
      error: error.message,
      config_used: {
        host: dbConfig.host,
        database: dbConfig.database,
        port: dbConfig.port,
        ssl: !!dbConfig.ssl
      }
    });
  }
});

// Enhanced debug endpoint
app.get("/debug", (req, res) => {
  res.json({
    environment_variables: {
      DATABASE_URL: process.env.DATABASE_URL ? "✅ Set" : "❌ Not set",
      MYSQL_URL: process.env.MYSQL_URL ? "✅ Set" : "❌ Not set",
      MYSQL_PRIVATE_URL: process.env.MYSQL_PRIVATE_URL ? "✅ Set" : "❌ Not set",
      DATABASE_PRIVATE_URL: process.env.DATABASE_PRIVATE_URL ? "✅ Set" : "❌ Not set",
      MYSQL_HOST: process.env.MYSQL_HOST || "Not set",
      MYSQL_USER: process.env.MYSQL_USER || "Not set", 
      MYSQL_DATABASE: process.env.MYSQL_DATABASE || "Not set",
      MYSQL_PORT: process.env.MYSQL_PORT || "Not set",
      MYSQL_PASSWORD: process.env.MYSQL_PASSWORD ? "✅ Set" : "❌ Not set",
      // Legacy variables
      DB_HOST: process.env.DB_HOST || "Not set",
      DB_USER: process.env.DB_USER || "Not set", 
      DB_NAME: process.env.DB_NAME || "Not set",
      DB_PORT: process.env.DB_PORT || "Not set",
      DB_PASS: process.env.DB_PASS ? "✅ Set" : "❌ Not set",
      NODE_ENV: process.env.NODE_ENV || "development"
    },
    parsed_config: {
      host: dbConfig.host,
      user: dbConfig.user,
      database: dbConfig.database,
      port: dbConfig.port,
      ssl: !!dbConfig.ssl
    },
    recommendations: {
      "Use Private Network": "Set MYSQL_PRIVATE_URL to avoid egress fees",
      "Check Service": "Ensure MySQL service is running in Railway",
      "Verify Network": "Both services should be in same Railway project"
    }
  });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🔄 SIGTERM received, closing database connections...');
  try {
    await pool.end();
    console.log('✅ Database connections closed');
  } catch (error) {
    console.error('❌ Error closing database connections:', error);
  }
  process.exit(0);
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
    available_endpoints: ["GET /", "GET /test", "GET /debug", "POST /scholarships"],
  });
});

// Start server
app.listen(PORT, async () => {
  console.log(`🚀 Server đang chạy tại port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  
  // Test database connection on startup
  const connected = await connectWithRetry();
  
  if (!connected) {
    console.error("❌ Server started but database connection failed");
    console.error("🔧 Server will continue running but API calls may fail");
  }
});
