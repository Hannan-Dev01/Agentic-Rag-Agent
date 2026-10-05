import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // A small, ChatGPT-like neutral palette. We'll build the real UI in Phase 9.
        surface: {
          DEFAULT: "#ffffff",
          muted: "#f7f7f8",
          border: "#e5e5e5",
        },
      },
    },
  },
  plugins: [],
};

export default config;
