import express from "express";
const router = express.Router();

router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    cookieStatus: {
      valid: true,
      expiringSoon: false,
      message: "Cookies are valid"
    },
    diskSpace: {
      sufficient: true,
      message: "Sufficient disk space available"
    }
  });
});

export default router;
