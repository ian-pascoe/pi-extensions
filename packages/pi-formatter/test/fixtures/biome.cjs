// Native CLI boundary: captured single-file JSON report shape, not a config resolver.
module.exports = (label, enabled = true) => {
  if (process.argv.includes("--reporter=json")) {
    if (process.argv.includes("--write") || !process.argv.includes("--no-errors-on-unmatched"))
      throw new Error("Eligibility must be a read-only format check");
    console.log(
      JSON.stringify({
        command: "format",
        summary: {
          changed: 0,
          unchanged: enabled ? 1 : 0,
          errors: 0,
          warnings: 0,
          skipped: 0,
          diagnosticsNotPrinted: 0,
        },
        diagnostics: [],
      }),
    );
  } else {
    require("node:fs").appendFileSync(process.argv.at(-1), `:${label}`);
  }
};
