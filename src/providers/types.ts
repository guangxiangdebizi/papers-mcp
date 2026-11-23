import type { FilterArgs, PaperRecord } from '../core/paper.js';
export interface SearchInput { query: string; filters: FilterArgs; sort: 'relevance' | 'date_desc' | 'citations_desc'; limit: number; }
export interface ProviderResult { items: PaperRecord[]; truncated: boolean; cache_hit?: boolean; }
// JSON from public indexes is normalized immediately at each provider boundary.
export type Json = Record<string, any>;
export const list = <T>(value: T | T[] | undefined | null): T[] => value == null ? [] : Array.isArray(value) ? value : [value];
export const clean = (s: unknown): string => String(s ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
