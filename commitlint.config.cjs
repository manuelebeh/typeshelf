/** @type {import('@commitlint/types').UserConfig} */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  // Dependabot writes conventional subjects but long URLs in the body, over the line length limit.
  ignores: [(message) => /^Signed-off-by: dependabot\[bot\]/m.test(message)],
};
