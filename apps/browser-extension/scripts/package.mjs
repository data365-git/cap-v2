import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..");
const distDir = join(rootDir, "dist");
const outputFile = join(rootDir, "..", "cap-recorder.zip");

if (!existsSync(distDir)) {
	console.error("dist/ directory not found. Run 'pnpm build' first.");
	process.exit(1);
}

try {
	execFileSync("zip", ["-r", outputFile, "."], {
		cwd: distDir,
		stdio: "inherit",
	});
	console.log(`Package created: ${outputFile}`);
} catch (err) {
	console.error("Failed to create package:", err.message);
	process.exit(1);
}
