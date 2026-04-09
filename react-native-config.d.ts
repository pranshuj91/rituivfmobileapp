declare module 'react-native-config' {
  export interface NativeConfig {
    CALL_LOG_APP_KEY?: string;
    CALL_LOG_SYNC_URL?: string;
    CALL_LOG_UPLOAD_URL?: string;
    CALL_LOG_AUTHORIZATION?: string;
  }

  const Config: NativeConfig;
  export default Config;
}
