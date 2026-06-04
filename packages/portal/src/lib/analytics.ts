import * as amplitude from '@amplitude/unified';

export const initAnalytics = () => {
  if (!import.meta.env.VITE_AMPLITUDE_KEY) return;
  amplitude.initAll(import.meta.env.VITE_AMPLITUDE_KEY, {
    "analytics": {
      "autocapture": {
        "attribution": true,
        "fileDownloads": true,
        "formInteractions": true,
        "pageViews": true,
        "sessions": true,
        "elementInteractions": true,
        "networkTracking": true,
        "webVitals": true,
        "frustrationInteractions": {
          "thrashedCursor": true,
          "errorClicks": true,
          "deadClicks": true,
          "rageClicks": true
        }
      }
    },
    "sessionReplay": {
      "sampleRate": 1
    }
  });
};

export const trackEvent = (eventName: string, eventProperties?: Record<string, any>) => {
  if (!import.meta.env.VITE_AMPLITUDE_KEY) return;
  amplitude.track(eventName, eventProperties);
};

export const identifyUser = (userId: string | null, userProperties?: Record<string, any>) => {
  if (!import.meta.env.VITE_AMPLITUDE_KEY) return;
  if (userId) {
    amplitude.setUserId(userId);
    if (userProperties) {
      const identify = new amplitude.Identify();
      for (const [key, value] of Object.entries(userProperties)) {
        identify.set(key, value);
      }
      amplitude.identify(identify);
    }
  } else {
    amplitude.setUserId(null as any); // Type cast for unified SDK if needed
  }
};
