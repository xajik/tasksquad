# Skill: Post Release Notes to Twitter

Post a release update tweet from `@Task_Squad_ai` using browser-use.

## Profile

Always use:
```bash
browser-use --profile "TaskSquad" --headed <command>
```

---

## Step-by-Step

### 1. Gather recent commits

Depending on user command, use latest tag version or duration.

```bash
git log --since="7 days ago" --oneline
```

### 2. Draft the tweet

Rules:
- **Stay under 220 chars** (Twitter's internal count differs — domain names like `TaskSquad.ai` are treated as URLs and count as 23 chars regardless of length)
- **No domain names** (e.g. use "TaskSquad" not "TaskSquad.ai")
- Keep it punchy — lead with a hook, bullet the features, close with a tagline

Example format:
```
Busy week shipping TaskSquad! Just release 0.2.20v:
- control panel for local debugging;
- rich text notes, convert notes and discussion into agent tasks;
- CLI skills for tsql for agent to debug itself
Building the best human+AI team tool 🚀
```

### 3. Open compose
```bash
browser-use --profile "TaskSquad" --headed open https://twitter.com/compose/tweet
sleep 1
```

### 4. Get textarea index
```bash
browser-use --profile "TaskSquad" --headed state 2>&1 | grep "contenteditable"
# Look for: [XXXXX]<div aria-label=Post text contenteditable=true ...
```

### 5. Click textarea
```bash
browser-use --profile "TaskSquad" --headed click <INDEX>
sleep 0.3
```

### 6. Type tweet content

For **single-paragraph tweets** (recommended — avoids newline issues):
```bash
browser-use --profile "TaskSquad" --headed type "Your tweet text here"
```

For **multi-line tweets** — type each line separately, use `keys "Enter"` (NOT `keys "Return"` or `keys "Return Return"`):
```bash
browser-use --profile "TaskSquad" --headed type "Line one"
browser-use --profile "TaskSquad" --headed keys "Enter"
browser-use --profile "TaskSquad" --headed keys "Enter"
browser-use --profile "TaskSquad" --headed type "Line two"
```

> **Never** use `execCommand` or DOM manipulation to set text — it bypasses React's state and the Post button stays disabled.

### 7. Handle hashtag autocomplete

If you end with a hashtag (e.g. `#buildinpublic`), an autocomplete dropdown appears.
- Do **not** press `Enter` — it selects the autocomplete suggestion instead of posting
- Press `Escape` only if autocomplete is showing (not mid-typing) — it dismisses the dropdown without closing the modal

### 8. Find and click Post button
```bash
browser-use --profile "TaskSquad" --headed state 2>&1 | grep -B2 "^		Post$"
# Note the button index e.g. [XXXXX]<button />

browser-use --profile "TaskSquad" --headed click <BUTTON_INDEX>
```

> Use the index-based click (not JS `.click()`) — clicking by index properly triggers Playwright's event which React responds to.

### 9. Verify
```bash
sleep 2
browser-use --profile "TaskSquad" --headed state 2>&1 | grep "Your post was sent"
```
Look for the toast: **"Your post was sent."** — no screenshot needed.

---

## Attaching Media (Images or Video)

The compose modal has a hidden `input[type=file]` as a SHADOW element. Upload directly to it — **no need to click the camera button first**.

```bash
# Find the file input index
browser-use --profile "TaskSquad" --headed state 2>&1 | grep "type=file"
# Look for: |SHADOW(open)|*[XXXXX]<input accept=image/jpeg... type=file ...

# Upload files one at a time (Twitter accepts up to 4 images, or 1 video)
browser-use --profile "TaskSquad" --headed upload <INDEX> /path/to/image.png
sleep 1
browser-use --profile "TaskSquad" --headed upload <INDEX> /path/to/image2.png
```

- Upload images **before** clicking and typing in the textarea
- For video: upload the `.mp4` using the same file input index
- Twitter accepts: `image/jpeg`, `image/png`, `image/webp`, `image/gif`, `video/mp4`, `video/quicktime`

---

## Posting a Thread (Multi-Tweet Reply)

After posting tweet 1:

### 1. Navigate to profile to find the tweet
```bash
browser-use --profile "TaskSquad" --headed open "https://twitter.com/Task_Squad_ai"
sleep 2
```

### 2. Find and click the Reply button on your latest tweet
```bash
browser-use --profile "TaskSquad" --headed state 2>&1 | grep "Replies\. Reply"
# Returns: [XXXXX]<button aria-label=0 Replies. Reply />  ← first one is your latest tweet
browser-use --profile "TaskSquad" --headed click <INDEX>
sleep 2
```

### 3. Upload media (optional) and type reply
```bash
# Find file input
browser-use --profile "TaskSquad" --headed state 2>&1 | grep "type=file"
browser-use --profile "TaskSquad" --headed upload <FILE_INPUT_INDEX> /path/to/video.mp4

# Find and click reply textarea
browser-use --profile "TaskSquad" --headed state 2>&1 | grep "contenteditable"
browser-use --profile "TaskSquad" --headed click <TEXTAREA_INDEX>
sleep 0.3
browser-use --profile "TaskSquad" --headed type "Your reply text here"
```

### 4. Post the reply
The reply dialog uses `data-testid="tweetButton"` (not `tweetButtonInline` like compose).
```bash
browser-use --profile "TaskSquad" --headed state 2>&1 | grep -B1 "Post$" | grep button
# Returns: [XXXXX]<button />
browser-use --profile "TaskSquad" --headed click <BUTTON_INDEX>
sleep 3
browser-use --profile "TaskSquad" --headed state 2>&1 | grep "Your post was sent"
```

---

## Common Pitfalls

| Problem | Cause | Fix |
|---|---|---|
| Post button stays disabled | Text typed via execCommand/DOM doesn't update React state | Always use `browser-use type` or `keys` |
| Modal closes unexpectedly | Pressed `Escape` when no autocomplete was showing | Only press `Escape` when autocomplete dropdown is visible |
| Tweet is over limit | Domain name (e.g. `.ai`) counted as URL (23 chars) | Avoid domain names in tweet text |
| `keys "Return Return"` types literal text | Wrong syntax | Use separate `keys "Enter"` calls |
| First line missing after multiline typing | First `type` fired before textarea focused | Add `sleep 0.3` after `click` before typing |
| Hashtag selects autocomplete | Pressed `Enter` while autocomplete was open | Press `Escape` first to dismiss autocomplete |
| Media not attaching | Tried to click camera button then upload | Use `browser-use upload <file_input_index>` directly — no camera button click needed |
| Reply post button not found | Reply uses different testid than compose | Find with `grep -B1 "Post$" \| grep button`, not `grep "tweetButtonInline"` |
| Wrong profile name | Profile name is case-sensitive | Use `"TaskSquad"` exactly — run `browser-use profile list` to verify |


## Twitter Chat Passcode

If prompted, your twitter chat passcode is: 1234