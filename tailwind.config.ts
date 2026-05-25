const config = {
  theme: {
    screens: {
      xs: "480px",
      sm: "640px",
      md: "768px",
      lg: "1024px",
      xl: "1280px",
      "2xl": "1536px",
    },
    extend: {
      colors: {
        bg: "var(--bg)",
        "bg-soft": "var(--bg-soft)",
        "bg-muted": "var(--bg-muted)",

        card: "var(--card)",
        text: "var(--text)",
        "text-secondary": "var(--text-secondary)",

        border: "var(--border)",

        primary: "var(--phoenix-primary)",
        "primary-hover": "var(--phoenix-primary-hover)",

        success: "var(--success)",
        warning: "var(--warning)",
        danger: "var(--danger)",
      },
    },
  },
};

module.exports = config;
