/**
 * @format
 */

import { AppRegistry } from 'react-native';
import BackgroundFetch from 'react-native-background-fetch';
import App from './App';
import { name as appName } from './app.json';
import { runScheduledSync } from './src/services/syncSchedule';

AppRegistry.registerComponent(appName, () => App);

const backgroundSyncHeadlessTask = async (event) => {
  const taskId = event.taskId;
  try {
    await runScheduledSync();
  } finally {
    BackgroundFetch.finish(taskId);
  }
};

BackgroundFetch.registerHeadlessTask(backgroundSyncHeadlessTask);
