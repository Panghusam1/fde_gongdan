import { runProjectDemo } from "../src/demo/run-project-demo.ts";

const result = await runProjectDemo();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
