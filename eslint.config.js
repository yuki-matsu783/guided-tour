/**
 * ESLint の設定（flat config）。
 * 型の抜け道（any・型アサーション・非 null アサーション）と、実行場所をまたぐ import を error にする。
 * 違反を消すためにこの設定を緩めない。
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * 相対パス・`src/`・`@/` で始まる指定のうち、禁止する直下ディレクトリを指すものを塞ぐ。
 * @param {string[]} targets 禁止する src 直下のディレクトリ名
 * @param {string} message 違反時のメッセージ
 */
function forbidImports(targets, message) {
  return {
    'no-restricted-imports': [
      'error',
      {
        patterns: targets.map((t) => ({
          regex: `^((\\.{1,2}/)+|@/|src/)(.*/)?${t}(/|$)`,
          message,
        })),
      },
    ],
  };
}

/** ディレクトリごとの禁止。キーは対象ディレクトリ、値は import できない相手。 */
const RULES = {
  'src/core': ['shared', 'background', 'content', 'sidepanel'],
  'src/content': ['background', 'sidepanel'],
  'src/background': ['content', 'sidepanel'],
  'src/sidepanel': ['content', 'background'],
  'src/shared': ['background', 'content', 'sidepanel'],
};

export default tseslint.config(
  { ignores: ['dist/**', 'release/**', 'node_modules/**', 'test-results/**'] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'never' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  },
  {
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  ...Object.entries(RULES).map(([dir, targets]) => ({
    files: [`${dir}/**/*.{ts,tsx}`],
    rules: forbidImports(
      targets,
      `${dir} から ${targets.join('・')} は import できない（実行場所をまたぐ依存の禁止）`,
    ),
  })),
  {
    files: ['src/core/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'chrome', message: 'src/core は拡張機能 API に依存しない' },
      ],
    },
  },
);

