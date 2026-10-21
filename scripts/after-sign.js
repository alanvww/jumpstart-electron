const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin' || process.env.CSC_LINK) {
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  const entitlementsPath = path.join(__dirname, '..', 'build', 'entitlements.mac.plist');

  console.log(`Applying ad-hoc signature with entitlements to ${appPath}...`);
  execFileSync(
    'codesign',
    ['--force', '--deep', '--sign', '-', '--entitlements', entitlementsPath, appPath],
    { stdio: 'inherit' }
  );

  execFileSync(
    'codesign',
    ['--verify', '--deep', '--strict', '--verbose=2', appPath],
    { stdio: 'inherit' }
  );
};
