-- Seed the ExampleApp flat-fee v2 email template.
-- Inserts only when this id and name are both absent, so an edited copy is left alone.
-- video_hook itself is cached on creators.ai_variables and needs no new column.
-- Apply on project your-project-ref. Do not run from the app.

INSERT INTO public.email_templates (id, app_id, name, subject, body)
SELECT
  'a0000000-0000-4000-8000-0000000000e3',
  NULL,
  'ExampleApp flat-fee v2',
  'Paid ExampleApp post, $75 flat',
  $preset$Hey {{first_name}}, {{video_hook}} I'm Alex, founder of {{app_name}}, an iOS app that scans a physical book and gives you the key ideas in seconds.

I'd love to pay you $75 flat for one TikTok, e.g. "5 ideas from [a book you're reading] in 30 seconds" using the app. Paid upfront, no affiliate links, and you keep creative control. If it performs there's a bonus, and we'd like to do more monthly.

Up for it? I can send the app and 3 example hooks today.

Alex
{{store_url}}$preset$
WHERE NOT EXISTS (
  SELECT 1
  FROM public.email_templates
  WHERE id = 'a0000000-0000-4000-8000-0000000000e3'
     OR name = 'ExampleApp flat-fee v2'
);

COMMENT ON COLUMN public.creators.ai_variables IS
  'JSON bag for personalisation. hook is the older pitch line. video_hook, video_hook_source (video, bio, or generic), video_hook_basis, and video_hook_edited cache the {{video_hook}} opening line.';
