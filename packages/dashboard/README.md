# @squad/dashboard

React + Vite web UI for a Squad gateway. It is a plain protocol client: everything it shows arrives over the WebSocket at `/ws` on the origin that served the page.

## Demo mode

Runs the dashboard on realistic sample data with no gateway, model or API key.

1. Start the mock gateway. It listens on `127.0.0.1:8092`; set `PORT` to change that.

   ```sh
   pnpm --filter @squad/dashboard mock
   ```

2. In a second terminal, start the dev server with the gateway routes proxied to the mock:

   ```sh
   SQUAD_GATEWAY=http://127.0.0.1:8092 pnpm --filter @squad/dashboard dev
   ```

3. Open http://localhost:5173, click "use a token instead →", enter any non-empty token such as `demo`, and click connect. The token is saved, so later reloads connect straight away.

The mock also approves pairing codes by itself, but under `vite dev` the "pair this browser" flow shows a code and never polls for the approval: React StrictMode runs `PairFlow`'s unmount cleanup in `src/views/Gate.tsx`, which sets `cancelledRef` for good. Use a token in dev.

There is no gateway URL field in the dashboard. It always connects to `/ws` on its own origin, so `SQUAD_GATEWAY` makes Vite proxy `/ws`, `/pair` and `/apps` to the mock. Without `SQUAD_GATEWAY` the dev server proxies nothing.

The sample squad is a PR review: a main agent splits the work across three subagents (researcher, reviewer, tester), each on its own model and budget, over one shared task list. One ask_user question and one approval wait for you on the Overview.

For the first 45 seconds after the dashboard connects, the reviewer streams its findings and completes its task. After that, a routine fires every minute and log lines keep arriving. Answering the question, deciding the approval and sending a chat message each play out a scripted turn. State lives in memory, so restart the mock to reset it.
