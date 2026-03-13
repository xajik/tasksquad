import { TwitterApi } from 'twitter-api-v2';
import fs from 'fs';
import dotenv from 'dotenv';

// Load .env
dotenv.config();

const client = new TwitterApi({
  appKey: process.env.TWITTER_API_KEY,
  appSecret: process.env.TWITTER_API_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
});

const rwClient = client.readWrite;

const PITCH = "TaskSquad.ai lets you use agentic setups on your machine, anytime, anywhere! 🚀 Remote control for ANY agent like #OpenCode or #ClaudeCode. Create teams, collaborate, and share tokens easily. Check it out!";

async function engage() {
  const queries = [
    '#OpenCode',
    '#ClaudeCode',
    '#AIAgents',
    'agent orchestration',
    'remote control AI agents'
  ];

  for (const query of queries) {
    console.log(`Searching for: ${query}`);
    try {
      const searchResult = await rwClient.v2.search(query, {
        max_results: 10,
        'tweet.fields': ['author_id', 'public_metrics', 'text'],
        expansions: 'author_id',
      });

      for (const tweet of searchResult) {
        // Skip our own tweets or very low engagement if we want high quality
        // But for now, let's just engage with recent ones.
        
        console.log(`Found tweet from ${tweet.author_id}: ${tweet.text.substring(0, 50)}...`);
        
        // Check if we already replied to this tweet (mock check for now)
        // In a real loop we'd track this in a DB or file.
        
        const replyText = `@${await getUsername(tweet.author_id)} ${PITCH}`;
        
        try {
          // Post reply
          const reply = await rwClient.v2.reply(PITCH, tweet.id);
          console.log(`Replied to tweet ${tweet.id}`);
          // Wait to avoid rate limits
          await new Promise(r => setTimeout(r, 5000));
        } catch (e) {
          if (e.code === 403) {
             console.log("Already replied or restricted.");
          } else {
             console.error("Error replying:", e);
          }
        }
      }
    } catch (e) {
      console.error(`Error searching for ${query}:`, e);
    }
  }
}

async function getUsername(authorId) {
    try {
        const user = await rwClient.v2.user(authorId);
        return user.data.username;
    } catch (e) {
        return "user";
    }
}

engage();
