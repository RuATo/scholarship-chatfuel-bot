require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Kết nối MySQL bằng connection pool
const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Test kết nối
db.getConnection((err, connection) => {
  if (err) {
    console.error("❌ Lỗi kết nối MySQL:", err.message);
  } else {
    console.log("✅ Kết nối MySQL thành công!");
    connection.release();
  }
});

// Route gốc
app.get("/", (req, res) => {
  res.json({ message: "Server đang chạy!" });
});

// Route lấy danh sách học bổng (lọc theo điều kiện)
app.get("/hocbong", (req, res) => {
  const { eligible_location, age, jlpt_min_level, eju_score, education_min } =
    req.query;

  let query = `
    SELECT 
    s.No AS ma_hoc_bong,
      s.scholarship_name AS ten_hoc_bong,
      c.eligible_location AS khu_vuc_ung_tuyen,
      c.age_max AS do_tuoi_toi_da,
      c.jlpt_min_level AS trinh_do_tieng_nhat_toi_thieu,
      c.eju_min_total AS diem_eju_toi_thieu,
      c.education_min AS trinh_do_hoc_van_toi_thieu,
      s.Monthly_Amount AS tro_cap_hang_thang,
  c.application_window AS thoi_gian_tuyen,
      s.Reference_link AS duong_dan_chinh_thuc,
      c.docs_required_core AS giay_to_bat_buoc,
      s.Notes AS ghi_chu
   FROM scholarships s
JOIN scholarship_conditions c ON s.No = c.scholarship_no
  `;

  const params = [];

  if (eligible_location) {
    if (eligible_location === "vietnam" || eligible_location === "japan") {
      query += " AND c.eligible_location = ?";
      params.push(eligible_location);
    } else {
      query += " AND c.eligible_location NOT IN ('vietnam', 'japan')";
    }
  }

  if (age) {
    query += " AND c.age_max >= ?";
    params.push(age);
  }

  if (jlpt_min_level) {
    const jlptMap = {
      N1: ["N1", "N2", "N3", "N4", "N5"],
      N2: ["N2", "N3", "N4", "N5"],
      N3: ["N3", "N4", "N5"],
      N4: ["N4", "N5"],
      N5: ["N5"],
    };

    const allowedLevels = jlptMap[jlpt_min_level] || [];
    if (allowedLevels.length > 0) {
      const placeholders = allowedLevels.map(() => "?").join(",");
      query += ` AND (c.jlpt_min_level IN (${placeholders}) OR c.jlpt_min_level IS NULL)`;
      params.push(...allowedLevels);
    }
  }

  if (eju_score) {
    query += " AND c.eju_min_total <= ?";
    params.push(eju_score);
  }

  if (education_min) {
    query += " AND c.education_min = ?";
    params.push(education_min);
  }

  db.query(query, params, (err, results) => {
    if (err) {
      console.error("❌ Lỗi truy vấn MySQL:", err.message);
      return res
        .status(500)
        .json({ error: "Lỗi server, vui lòng thử lại sau." });
    }

    if (results.length === 0) {
      return res.json({
        message: "Không tìm thấy học bổng phù hợp với điều kiện bạn nhập.",
      });
    }

    // 🌸 Format kết quả rõ ràng, có nguồn bảng
    const formatted = results.map((row, index) => {
      return `#${index + 1} 🎓 ${row.ten_hoc_bong}
📍 Khu vực (c.eligible_location): ${row.khu_vuc_ung_tuyen || "Không rõ"}
🧒 Độ tuổi tối đa (c.age_max): ${row.do_tuoi_toi_da || "Không giới hạn"}
💬 JLPT yêu cầu (c.jlpt_min_level): ${
        row.trinh_do_tieng_nhat_toi_thieu || "Không yêu cầu"
      }
📊 Điểm EJU tối thiểu (c.eju_min_total): ${row.diem_eju_toi_thieu || 0}
🎓 Trình độ học vấn (c.education_min): ${
        row.trinh_do_hoc_van_toi_thieu || "Không rõ"
      }
💴 Trợ cấp (s.Monthly_Amount): ${row.tro_cap_hang_thang || "Không có thông tin"}
🕒 Thời gian tuyển (c.application_window): ${row.thoi_gian_tuyen || "Không rõ"}
🔗 Link chính thức (s.Reference_link): ${row.duong_dan_chinh_thuc || "Không có"}
📄 Giấy tờ bắt buộc (c.docs_required_core): ${
        row.giay_to_bat_buoc || "Không có thông tin"
      }
📝 Ghi chú (s.Notes): ${row.ghi_chu || "Không có"}
──────────────────────────────`;
    });

    // 🌈 Trả về JSON đẹp
    res.json({
      tong_so_ket_qua: results.length,
      ket_qua_tim_thay: formatted,
    });
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server chạy tại http://localhost:${PORT}`);
});
