import type { ConfigContext, ExpoConfig } from "expo/config";

const PRODUCTION_IOS_BUNDLE_ID = "com.buzz.buzzMobile";
const PRODUCTION_ANDROID_PACKAGE = "xyz.block.buzz.mobile";

function readIdentityOverride(
  name: string,
  productionValue: string,
  pattern: RegExp,
): string {
  const value = process.env[name]?.trim();
  if (!value) {
    return productionValue;
  }
  if (!pattern.test(value)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return value;
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const name =
    process.env.BUZZ_MOBILE_APP_NAME?.trim() || config.name || "Buzz";
  if (!/^Buzz(?:-[A-Za-z0-9._-]+)?$/.test(name)) {
    throw new Error(`Invalid BUZZ_MOBILE_APP_NAME: ${name}`);
  }

  const iosBundleIdentifier = readIdentityOverride(
    "BUZZ_MOBILE_IOS_BUNDLE_IDENTIFIER",
    PRODUCTION_IOS_BUNDLE_ID,
    /^com\.buzz\.buzzMobile(?:\.[a-z0-9-]+)?$/,
  );
  const androidPackage = readIdentityOverride(
    "BUZZ_MOBILE_ANDROID_PACKAGE",
    PRODUCTION_ANDROID_PACKAGE,
    /^xyz\.block\.buzz\.mobile(?:\.[a-z][a-z0-9_]*)?$/,
  );

  return {
    ...config,
    name,
    slug: config.slug || "buzz-mobile",
    ios: {
      ...config.ios,
      bundleIdentifier: iosBundleIdentifier,
    },
    android: {
      ...config.android,
      package: androidPackage,
    },
  };
};
