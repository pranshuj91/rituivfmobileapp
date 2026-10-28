declare module 'react-native-config' {
  export interface NativeConfig {
    /** Gaincafe CRM API base, e.g. https://whatsapp.gaincafe.com/api */
    CRM_API_BASE_URL?: string;
  }

  const Config: NativeConfig;
  export default Config;
}
