# English Writing Trainer

A local web app for Chinese native speakers who want to practice Chinese-to-English writing. The app generates translation questions, grades answers with Zhipu GLM-4.7-Flash, and stores training progress locally in SQLite.

## Features

- Initial ability assessment across six grammar dimensions: tense, prepositions, relative clauses, conjunctions, passive voice, and articles.
- Daily practice that prioritizes weak dimensions and unresolved mistakes.
- Focused practice for a selected grammar dimension.
- Mistake review that removes an item after two consecutive correct answers.
- AI grading with verdicts, reference answers, error labels, explanations, and memory tips.
- Progress dashboard with a radar chart, 30-day trend, error distribution, training records, and streak count.
- Local username/password accounts with invite-only registration and per-user training data.
- Admin management for invites, users, password resets, and global GLM settings.

## Requirements

- Node.js
- npm
- Zhipu AI API key with access to `glm-4.7-flash`

## Getting Started

Install dependencies:

```bash
npm install
```

Create the first admin account by setting these environment variables before the first run:

```bash
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-this-password
```

Start the development server:

```bash
npm run dev
```

Open the app in your browser:

```text
http://localhost:3000
```

## Configure GLM-4.7-Flash

1. Create a Zhipu AI API key and put it in `.env`:

```bash
ZAI_API_KEY=your-api-key
```

2. Log in as an admin, then open the app's Settings page and configure:

- GLM API URL, default `https://open.bigmodel.cn/api/paas/v4`
- Model name, default `glm-4.7-flash`
- Temperature, default `0.3`
- Daily question count. This is a per-user preference; GLM connection settings are admin-only.
- Application concurrency is fixed at `1` because the free GLM-4.7-Flash model only allows one concurrent request.

3. Restart the server after editing `.env`, then click the connection test button in Settings before starting an assessment or practice session.

## Data Storage

The SQLite database is created automatically at:

```text
data/trainer.db
```

Delete that file to manually clear all local users and training data. The in-app reset only clears the current user's training data.

## Available Scripts

```bash
npm run dev
```

Runs the Next.js development server.

```bash
npm run build
```

Creates a production build.

```bash
npm run start
```

Starts the production server after a build.

```bash
npm run lint
```

Runs the configured lint command.

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE) for details.
