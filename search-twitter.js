import { TwitterApi } from 'twitter-api-v2';
import fs from 'fs';

const env = fs.readFileSync('.env', 'utf-8');
const getEnv = (key) => env.match(new RegExp(`${key}=(.*)`))?.[1]?.trim();

const client = new TwitterApi({
  appKey: getEnv('TWITTER_API_KEY'),
  appSecret: getEnv('TWITTER_API_SECRET'),
  accessToken: getEnv('TWITTER_ACCESS_TOKEN'),
  accessSecret: getEnv('TWITTER_ACCESS_TOKEN_SECRET'),
});

const rwClient = client.readWrite;

async function searchTweets() {
  const queries = [
    '#OpenCode',
    '#ClaudeCode',
    'AI agents local',
    'agent orchestration'
  ];

  for (const query of queries) {
    console.log(`\n--- SEARCHING FOR: ${query} ---`);
    try {
      const searchResult = await rwClient.v2.search(query, {
        max_results: 10,
        'tweet.fields': ['author_id', 'public_metrics', 'text', 'created_at'],
        expansions: 'author_id',
      });

      if (searchResult.data.data) {
          for (const tweet of searchResult.data.data) {
              const author = searchResult.data.includes.users.find(u => u.id === tweet.author_id);
              console.log(`ID: ${tweet.id}`);
              console.log(`Author: @${author?.username || tweet.author_id}`);
              console.log(`Engagement: ${JSON.stringify(tweet.public_metrics)}`);
              console.log(`Text: ${tweet.text}\n`);
          }
      } else {
          console.log("No tweets found.");
      }
    } catch (e) {
      console.error(`Error searching for ${query}:`, e);
    }
  }
}

searchTweets();
