-- Data-driven service types (§4.6, §7). Adding a service = a seed row, never
-- code. Keys match each vertical's serviceSpec().serviceTypeKeys.
insert into catalogue.service_types (key, vertical_key, label_i18n, pricing_model, requires_calendar, requires_vehicle) values
  ('oil_change','workshop','{"en":"Oil change","es":"Cambio de aceite","fr":"Vidange"}','fixed',true,true),
  ('brake_service','workshop','{"en":"Brake service","es":"Servicio de frenos","fr":"Service de freins"}','quote',true,true),
  ('general_repair','workshop','{"en":"General repair","es":"Reparación general","fr":"Réparation générale"}','quote',true,true),
  ('part_installation','workshop','{"en":"Part installation","es":"Instalación de piezas","fr":"Pose de pièces"}','quote',true,true),
  ('dent_repair','body_paint','{"en":"Dent repair","es":"Reparación de abolladuras","fr":"Débosselage"}','quote',true,true),
  ('full_respray','body_paint','{"en":"Full respray","es":"Pintado completo","fr":"Peinture complète"}','quote',true,true),
  ('paint_touch_up','body_paint','{"en":"Paint touch-up","es":"Retoque de pintura","fr":"Retouche peinture"}','fixed',true,true),
  ('obd_scan','diagnostics','{"en":"OBD-II scan","es":"Escaneo OBD-II","fr":"Diagnostic OBD-II"}','fixed',true,true),
  ('pre_purchase_inspection','diagnostics','{"en":"Pre-purchase inspection","es":"Inspección pre-compra","fr":"Inspection pré-achat"}','fixed',true,true),
  ('emissions_test','diagnostics','{"en":"Emissions test","es":"Prueba de emisiones","fr":"Test d’émissions"}','fixed',true,true)
on conflict (key) do update set
  vertical_key = excluded.vertical_key,
  label_i18n = excluded.label_i18n,
  pricing_model = excluded.pricing_model;
