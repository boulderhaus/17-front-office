import { runAllSimulations } from "../src/application/simulator.js";

const results = await runAllSimulations();
for (const result of results) {
  console.log(`${result.passed ? "PASS" : "FAIL"} ${result.label}: ${result.observed}`);
}

const failed = results.filter((result) => !result.passed);
console.log(`\n${results.length - failed.length}/${results.length} launch scenarios passed.`);
if (failed.length > 0) process.exitCode = 1;
