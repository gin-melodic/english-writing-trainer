# English Writing Trainer

A local web app for Chinese native speakers who want to practice Chinese-to-English writing. The app generates translation questions, grades answers with an OpenAI-compatible LM Studio endpoint, and stores training progress locally in SQLite.

## Features

- Initial ability assessment across six grammar dimensions: tense, prepositions, relative clauses, conjunctions, passive voice, and articles.
- Daily practice that prioritizes weak dimensions and unresolved mistakes.
- Focused practice for a selected grammar dimension.
- Mistake review that removes an item after two consecutive correct answers.
- AI grading with verdicts, reference answers, error labels, explanations, and memory tips.
- Progress dashboard with a radar chart, 30-day trend, error distribution, training records, and streak count.
- Local username/password accounts with invite-only registration and per-user training data.
- Admin management for invites, users, password resets, and global LM Studio settings.

## Requirements

- Node.js
- npm
- LM Studio with a loaded chat model that can handle Chinese and English writing feedback

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

## Configure LM Studio

1. Open LM Studio and load a chat model suitable for bilingual writing feedback.
2. Start the local LM Studio server. The default endpoint is usually:

```text
http://localhost:1234
```

3. Log in as an admin, then open the app's Settings page and configure:

- LM Studio base URL, for example `http://localhost:1234`
- Model name, matching the model loaded in LM Studio
- Temperature, default `0.3`
- Daily question count. This is a per-user preference; LM Studio connection settings are admin-only.

4. Click the connection test button in Settings before starting an assessment or practice session.

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
