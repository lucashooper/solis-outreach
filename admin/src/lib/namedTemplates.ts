const KEY = 'solis-named-templates';

export interface NamedTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
}

export function readNamedTemplates(): NamedTemplate[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((row) => {
      if (!row || typeof row !== 'object') return [];
      const item = row as Partial<NamedTemplate>;
      if (typeof item.name !== 'string' || typeof item.body !== 'string') return [];
      return [
        {
          id: typeof item.id === 'string' ? item.id : item.name,
          name: item.name,
          subject: typeof item.subject === 'string' ? item.subject : '',
          body: item.body,
        },
      ];
    });
  } catch {
    return [];
  }
}
