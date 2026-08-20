import { clearSession, getToken, notifySessionExpired } from './session';
import type {
  ApiErrorBody,
  Email,
  EmailStats,
  EmailStatus,
  LoginResponse,
  Paginated,
  ScheduleRequest,
  ScheduleResponse,
  Sender,
  Throughput,
} from '@/types/api';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Set for endpoints that work without a session (login, health). */
  anonymous?: boolean;
  signal?: AbortSignal;
}

/**
 * The single place that talks to the API: attaches the bearer token, unwraps
 * the `{ error: { code, message } }` envelope into a typed `ApiError`, and
 * signs the user out when the token is rejected.
 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (!options.anonymous) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', `Cannot reach the API at ${API_URL}. Is the backend running?`);
  }

  if (response.status === 401 && !options.anonymous) {
    clearSession();
    notifySessionExpired();
  }

  if (response.status === 204) return undefined as T;

  const payload = (await response.json().catch(() => null)) as ApiErrorBody | T | null;

  if (!response.ok) {
    const error = (payload as ApiErrorBody | null)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'unknown_error',
      error?.message ?? `Request failed with status ${response.status}`,
      error?.details,
    );
  }

  return payload as T;
}

export interface ListEmailsParams {
  group: 'scheduled' | 'sent' | 'all';
  status?: EmailStatus;
  search?: string;
  page?: number;
  pageSize?: number;
  signal?: AbortSignal;
}

function toQueryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

export const api = {
  loginWithGoogle: (idToken: string) =>
    request<LoginResponse>('/api/auth/google', { method: 'POST', body: { idToken }, anonymous: true }),

  listEmails: ({ signal, ...params }: ListEmailsParams) =>
    request<Paginated<Email>>(
      `/api/emails${toQueryString({
        group: params.group,
        status: params.status,
        search: params.search,
        page: params.page ?? 1,
        pageSize: params.pageSize ?? 20,
      })}`,
      { signal },
    ),

  stats: (signal?: AbortSignal) => request<EmailStats>('/api/emails/stats', { signal }),

  schedule: (payload: ScheduleRequest) =>
    request<ScheduleResponse>('/api/emails/schedule', { method: 'POST', body: payload }),

  cancelEmail: (id: string) =>
    request<{ id: string; status: EmailStatus }>(`/api/emails/${id}/cancel`, { method: 'POST' }),

  senders: (signal?: AbortSignal) =>
    request<{ items: Sender[]; global: { used: number; limit: number } }>('/api/senders', { signal }),

  throughput: (signal?: AbortSignal) => request<Throughput>('/api/system/throughput', { signal }),
};
