// ESLint flat config：typescript-eslint 推荐规则打底。
// 学习项目里非空断言（xs[i]!）用得多且都有边界保证，关掉对应告警。
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "logs/", "sessions/"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // 本仓库有意使用逗号表达式的紧凑写法（如 `(histNav(-1), (i += 3))`），不当错误。
      "@typescript-eslint/no-unused-expressions": "off",
    },
  }
);
