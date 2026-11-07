-- Car listings can hold a photo that will actually load.
--
-- `photo_urls text[]` asked the client for a URL, and the client has no
-- URL to give. Every bucket is private: after `POST /v1/media/uploads`
-- the app holds a (bucket, path) pair and a one-time upload handle that
-- expires in two hours, neither of which is a thing an <img> can show.
-- So the sell-a-car screen uploaded the photo and then sent no photo —
-- on this database, `vehicle-photos` holds objects while EVERY listing
-- has `photo_urls = '{}'`. The bytes are there; nothing ever pointed at
-- them.
--
-- `photos` stores the pair instead, and the API signs a short-lived URL
-- when the listing is read.

alter table marketplace.car_listings
  add column if not exists photos jsonb not null default '[]'::jsonb;

/*
  A listing's photos are an ordered array of {bucket, path} — the order is
  the gallery order, so it is a jsonb array and not a side table keyed by
  an ordinal nobody would otherwise need. The CHECK keeps it an array
  rather than whatever else jsonb would accept; the contents are validated
  in the service, where the caller's own upload namespace is known.
*/
alter table marketplace.car_listings
  drop constraint if exists car_listings_photos_is_array;
alter table marketplace.car_listings
  add constraint car_listings_photos_is_array
  check (jsonb_typeof(photos) = 'array');

/*
  `photo_urls` STAYS, and stays readable. It is the field the shipped app
  sends today, and a listing created by a client we cannot redeploy must
  not start failing because the backend moved on. A row may now carry
  either, and the read path returns both merged into `photoUrls`.
*/
comment on column marketplace.car_listings.photo_urls is
  'Legacy: absolute URLs supplied by the client. Prefer `photos`.';
comment on column marketplace.car_listings.photos is
  'Array of {bucket, path} into a private bucket; signed on read.';
