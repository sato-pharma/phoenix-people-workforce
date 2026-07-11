-- Insert the IGNORE sentinel so the normalizer can persist "we don't sell this" product aliases
-- without violating the FK on source_of_sales_product_aliases(product_code → source_of_sales_products).
INSERT INTO source_of_sales_products (
  product_code, product_name, normalized_product_name,
  factory_price, family, family_code, source, line, normalized_line,
  source_file, source_sheet, active
)
VALUES (
  'IGNORE', 'Ignored — not a Phoenix product', 'ignored not a phoenix product',
  0, 'IGNORE', 'IGNORE', 'system', 'IGNORE', 'ignore',
  'system', 'system', true
)
ON CONFLICT (product_code) DO NOTHING;
