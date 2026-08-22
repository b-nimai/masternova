import type {
  CompleteUploadInput,
  CreateUploadInput,
  CreateUploadResult,
  PublicUser,
  Video,
} from '@masternova/shared';

/**
 * Thin fetch wrapper. All requests are same-origin (Next rewrites /api → NestJS),
 * so the session cookie rides along; `credentials: 'include'` is belt-and-braces.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new ApiError(res.status, body?.message ?? res.statusText);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const api = {
  register: (data: { email: string; password: string; name?: string }) =>
    request<PublicUser>('/auth/register', { method: 'POST', body: JSON.stringify(data) }),
  login: (data: { email: string; password: string }) =>
    request<PublicUser>('/auth/login', { method: 'POST', body: JSON.stringify(data) }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  me: () => request<PublicUser>('/auth/me'),
  listVideos: () => request<Video[]>('/videos'),
  createVideo: (data: { title: string; description?: string }) =>
    request<Video>('/videos', { method: 'POST', body: JSON.stringify(data) }),
  deleteVideo: (id: string) => request<void>(`/videos/${id}`, { method: 'DELETE' }),

  // Multipart upload: open a session, then PUT each part straight to S3/MinIO (not via
  // this client), then report the per-part ETags back to finalize.
  createUpload: (data: CreateUploadInput) =>
    request<CreateUploadResult>('/videos/uploads', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  completeUpload: (videoId: string, data: CompleteUploadInput) =>
    request<{ status: string }>(`/videos/${videoId}/uploads/complete`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  abortUpload: (videoId: string) =>
    request<void>(`/videos/${videoId}/uploads/abort`, { method: 'POST' }),
};
