import { TwitterApi } from 'twitter-api-v2';
import fs from 'fs';

const env = fs.readFileSync('.env', 'utf-8');
const getEnv = (key) => env.match(new RegExp(`${key}=(.*)`))?.[1]?.trim();

const client = new TwitterApi({
  appKey: getEnv('TWITTER_API_KEY_OLD'),
  appSecret: getEnv('TWITTER_API_SECRET_OLD'),
  accessToken: getEnv('TWITTER_ACCESS_TOKEN'),
  accessSecret: getEnv('TWITTER_ACCESS_TOKEN_SECRET'),
});

const rwClient = client.readWrite;

async function postTweet(text) {
  try {
    const tweet = await rwClient.v2.tweet(text);
    console.log('Posted:', tweet.data.text);
    return tweet.data.id;
  } catch (err) {
    console.error('Error posting tweet:', JSON.stringify(err.data || err.message, null, 2));
    throw err;
  }
}

async function main() {
  const tweets = [
    "🚀 Big release! TaskSquad v0.2.9 is here with major performance improvements & new features.",
    "⚡ New: ETag polling with KV version cache for faster real-time updates. Also added rate limiting to prevent API abuse.",
    "🔐 Security upgrade: Secure daemon login with improved authentication. Plus FCM notifications now work for all team members.",
    "🛠️ Plus: opencode plugin with transcript support, better UI scrolling, and 10+ bug fixes. Full changelog in comments! #DevTools #OpenSource"
  ];

  let previousTweetId = null;
  for (let i = 0; i < tweets.length; i++) {
    const tweet = i > 0 && previousTweetId ? `${tweets[i]}` : tweets[i];
    const result = await postTweet(tweet);
    previousTweetId = result.data.id;
    console.log(`Tweet ${i + 1}/${tweets.length} posted successfully`);
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log('All tweets posted!');
}

main();
