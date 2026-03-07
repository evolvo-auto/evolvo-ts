function requireEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is not set in the environment variables.`);
  }

  return value;
}

export const CONTEXT7_API_KEY = requireEnv("CONTEXT7_API_KEY");
export const OPENAI_API_KEY = requireEnv("OPENAI_API_KEY");
export const GITHUB_TOKEN = requireEnv("GITHUB_TOKEN");
export const GITHUB_OWNER = requireEnv("GITHUB_OWNER");
export const GITHUB_REPO = requireEnv("GITHUB_REPO");
