import { Bot } from 'grammy';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');

export const bot = new Bot(token);
export const telegram = bot.api;

export async function sendTelegramText(chatId: string | number, text: string): Promise<void> {
  const chunks = splitTelegramText(text || '(no text returned)');
  for (const chunk of chunks) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await telegram.sendMessage(chatId, chunk);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
    if (lastError) throw lastError;
  }
}

function splitTelegramText(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 4000) {
    let splitAt = remaining.lastIndexOf('\n', 4000);
    if (splitAt < 1000) splitAt = 4000;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
