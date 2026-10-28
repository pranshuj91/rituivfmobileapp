import React from 'react';
import { Image, type ImageProps, type StyleProp, type ImageStyle } from 'react-native';

type LogoProps = Omit<ImageProps, 'source'> & {
  width?: number;
  height?: number;
  style?: StyleProp<ImageStyle>;
};

/** GainCafe brand logo (transparent). Prefer on light backgrounds. */
export function Logo({ width = 220, height = 44, style, ...rest }: LogoProps) {
  return (
    <Image
      source={require('../../assets/logo_gaincafe.png')}
      style={[{ width, height }, style]}
      resizeMode="contain"
      {...rest}
    />
  );
}

/** White wordmark variant for dark backgrounds. */
export function LogoOnDark({ width = 220, height = 44, style, ...rest }: LogoProps) {
  return (
    <Image
      source={require('../../assets/logo_gaincafe_on_dark.png')}
      style={[{ width, height }, style]}
      resizeMode="contain"
      {...rest}
    />
  );
}

/** Dark wordmark variant for light backgrounds. */
export function LogoOnLight({ width = 220, height = 44, style, ...rest }: LogoProps) {
  return (
    <Image
      source={require('../../assets/logo_gaincafe_on_light.png')}
      style={[{ width, height }, style]}
      resizeMode="contain"
      {...rest}
    />
  );
}
