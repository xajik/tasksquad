---
name: release_log_to_twitter
description: Generate a diff between the last release tag and current state, create tweets, and post to Twitter. Use when sharing release notes on Twitter.
disable-model-invocation: true
allowed-tools: Bash(git *), Bash(node *), Read
---

# Release Log to Twitter

This skill generates a changelog from git commits between the last release tag and HEAD, formats it as engaging tweets, and posts them to Twitter.

## Prerequisites

1. Create a `.env` file in your project root with Twitter API credentials:

   **Option A: Bearer Token (OAuth 2.0 - App-only)**
   ```
   TWITTER_BEARER_TOKEN=your_bearer_token
   ```

   **Option B: Full OAuth 1.0a**
   ```
   TWITTER_API_KEY=your_api_key
   TWITTER_API_SECRET=your_api_secret
   TWITTER_ACCESS_TOKEN=your_access_token
   TWITTER_ACCESS_TOKEN_SECRET=your_access_token_secret
   ```

2. Install Twitter API client:
   ```bash
   npm install twitter-api-v2
   ```

## Steps

### Step 1: Find the last release tag

Run the following command to get the most recent tag:
```bash
git describe --tags --abbrev=0
```

If no tags exist, ask the user to create one:
```bash
git tag -a v0.1.0 -m "Release v0.1.0"
```

### Step 2: Generate the diff

Get all commits since the last tag:
```bash
git log LAST_TAG..HEAD --pretty=format:"%s" | head -50
```

Also get a summary of changed files:
```bash
git diff LAST_TAG..HEAD --stat
```

### Step 3: Analyze changes and create tweet narrative

Review the commits and categorize them:
- New features (feat:)
- Bug fixes (fix:)
- Refactoring (refactor:)
- Documentation (docs:)
- Dependencies (chore:, deps:)

Create a compelling story with 2-5 tweets:
1. **Hook tweet**: Exciting announcement (new version, major improvements)
2. **Feature tweets**: Highlight key changes (1-2 tweets)
3. **Call to action**: Encourage trying it out

Keep each tweet under 280 characters. Use emoji sparingly. Include relevant hashtags like #DevTools #OpenSource.

### Step 4: Post tweets using Twitter API

Create a small script to post tweets. Use the Twitter API v2 client:

```javascript
import { TwitterApi } from 'twitter-api-v2';
import fs from 'fs';

const env = fs.readFileSync('.env', 'utf-8');
const getEnv = (key) => env.match(new RegExp(`${key}=(.*)`))?.[1]?.trim();

// Check if using bearer token (OAuth 2.0) or full OAuth 1.0a
const bearerToken = getEnv('TWITTER_BEARER_TOKEN');

let client;
if (bearerToken) {
  // OAuth 2.0 - App-only authentication (read + write if token has write scope)
  client = new TwitterApi(bearerToken);
} else {
  // OAuth 1.0a - User context
  client = new TwitterApi({
    appKey: getEnv('TWITTER_API_KEY'),
    appSecret: getEnv('TWITTER_API_SECRET'),
    accessToken: getEnv('TWITTER_ACCESS_TOKEN'),
    accessSecret: getEnv('TWITTER_ACCESS_TOKEN_SECRET'),
  });
}

const rwClient = client.readWrite;

async function postTweet(text) {
  try {
    const tweet = await rwClient.v2.tweet(text);
    console.log('Posted:', tweet.data.text);
    return tweet.data.id;
  } catch (err) {
    console.error('Error posting tweet:', err);
    throw err;
  }
}

const tweets = [
  "Tweet 1 text...",
  "Tweet 2 text...",
  "Tweet 3 text..."
];

let previousTweetId = null;
for (const tweet of tweets) {
  const result = await postTweet(previousTweetId ? `${previousTweetId ? '' : ''}${tweet}` : tweet);
  previousTweetId = result.data.id;
  await new Promise(r => setTimeout(r, 1000));
}
```

### Step 5: Execute and verify

1. Run the script to post tweets
2. Verify tweets appear on Twitter
3. Report success to user

## Example Output

For a typical release, you might create:
- Tweet 1: "🚀 Big release! v1.2.0 is here with major performance improvements and new features."
- Tweet 2: "✨ New features: Added dark mode, improved search, and real-time sync."
- Tweet 3: "🐛 Fixed 15 bugs including the login issue and memory leaks."
- Tweet 4: "📦 Try it now! Full changelog in comments. #DevTools #OpenSource"

## Notes

- Always load API keys from `.env` file - never hardcode credentials
- Wait 1-2 seconds between tweets to avoid rate limits
- If posting fails, show the error and let user retry
- Use thread format (reply to previous tweet) for multi-tweet releases
- Bearer token requires OAuth 2.0 with "Read and Write" scope in your Twitter App settings
