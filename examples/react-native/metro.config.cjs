const { existsSync } = require("node:fs");
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const packageRoot = path.resolve(projectRoot, "../..");

function findDependencyRoot(start) {
  let candidate = start;
  for (;;) {
    if (existsSync(path.join(candidate, "node_modules"))) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) return packageRoot;
    candidate = parent;
  }
}

const dependencyRoot = findDependencyRoot(packageRoot);
const packageSourceRoot = path.join(packageRoot, "src");
const config = getDefaultConfig(projectRoot);

config.watchFolders = [packageRoot];
config.resolver.nodeModulesPaths = [...new Set([
  path.join(projectRoot, "node_modules"),
  path.join(packageRoot, "node_modules"),
  path.join(dependencyRoot, "node_modules"),
])];
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  "@hraness/direct": packageRoot,
};
config.resolver.unstable_enablePackageExports = true;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const relativeOrigin = path.relative(packageSourceRoot, context.originModulePath);
  const comesFromPackageSource = relativeOrigin !== ""
    && !relativeOrigin.startsWith(`..${path.sep}`)
    && relativeOrigin !== ".."
    && !path.isAbsolute(relativeOrigin);
  if (comesFromPackageSource && /^\.\.?\/.+\.js$/u.test(moduleName)) {
    return context.resolveRequest(context, moduleName.slice(0, -3), platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
