import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const source = join(projectRoot, "native", "frame_codec.cc");
const outputDirectory = join(projectRoot, "build", "Release");
const output = join(outputDirectory, "frame_codec.node");

const configuredPrefix = process.config.variables.node_prefix;
if (typeof configuredPrefix !== "string" || configuredPrefix.length === 0) {
  throw new Error("Unable to determine the Node.js installation prefix.");
}

const includeDirectory = join(configuredPrefix, "include", "node");
if (!existsSync(join(includeDirectory, "node_api.h"))) {
  throw new Error(`Node-API headers were not found under ${includeDirectory}.`);
}

mkdirSync(outputDirectory, { recursive: true });

const compiler = process.env.CXX ?? (process.platform === "darwin" ? "clang++" : "c++");
const commonArguments = [
  "-std=c++20",
  "-O3",
  "-fPIC",
  "-Wall",
  "-Wextra",
  "-Wpedantic",
  "-DNAPI_VERSION=8",
  `-I${includeDirectory}`,
  source,
  "-o",
  output,
];

const linkArguments =
  process.platform === "darwin"
    ? ["-bundle", "-undefined", "dynamic_lookup"]
    : process.platform === "linux"
      ? ["-shared"]
      : null;

if (linkArguments === null) {
  throw new Error(
    `The dependency-free build script currently supports macOS and Linux, not ${process.platform}.`,
  );
}

const result = spawnSync(compiler, [...commonArguments, ...linkArguments], {
  cwd: projectRoot,
  encoding: "utf8",
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  throw new Error(`Native compilation failed with exit code ${result.status ?? "unknown"}.`);
}

console.log(
  JSON.stringify({
    event: "native_build_complete",
    compiler,
    node: process.version,
    output,
  }),
);
