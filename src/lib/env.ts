import { env } from 'cloudflare:workers';
import type { AIService } from './ai';

export interface AppEnv {
	AI?: AIService;
}

export function getAppEnv(): AppEnv {
	return env as AppEnv;
}