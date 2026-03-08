import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      EVOLVO_DISCORD_TRANSPORT: "disabled",
    },
  },
});
