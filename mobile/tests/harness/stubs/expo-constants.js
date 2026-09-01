export const expoConfig = {
  name: 'FinSight',
  slug: 'finsight',
  extra: {
    apiBaseUrl: 'http://harness.test',
    supabaseUrl: 'http://supabase.harness.test',
    supabaseAnonKey: 'harness-anon-key',
  },
};

export const executionEnvironment = 'storeClient';
export const appOwnership = null;

export default {
  expoConfig,
  executionEnvironment,
  appOwnership,
  manifest: null,
  manifest2: null,
};
