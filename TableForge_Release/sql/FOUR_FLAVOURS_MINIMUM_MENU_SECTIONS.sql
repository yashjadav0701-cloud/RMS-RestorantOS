-- Four Flavours menu taxonomy normalization and missing approved menu rows.
-- Target tenant: Four Flavours only (197ff1e2-dd53-47a4-a5d5-46b3896ac021).
-- Adds a separate cuisine field and reduces active customer-facing sections to:
-- Soups, Salads (global), Starters & Tandoor, Platters & Sizzlers, Main Course,
-- Breads & Rice, Noodles & Fried Rice, Pasta, Pizza & Bakes, Papad (global),
-- Desserts (global), Beverages (global).
-- Idempotent: matches existing products by case-insensitive name and inserts only missing rows.
-- Existing IDs/images/recipes/order history are retained; explicit user-priced items get the supplied price.
-- Rows whose workbook note says estimated/confirm are marked price_review_required=true.
-- Back up production before running. Do not run against other restaurants.

BEGIN;
SET LOCAL lock_timeout = '10s';
LOCK TABLE public.products IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.restaurants WHERE id='197ff1e2-dd53-47a4-a5d5-46b3896ac021'::uuid AND slug='four-flavours') THEN
    RAISE EXCEPTION 'Four Flavours tenant id/slug did not match. No menu changes applied.';
  END IF;
END;
$preflight$;

ALTER TABLE public.products ADD COLUMN IF NOT EXISTS cuisine text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS price_review_required boolean NOT NULL DEFAULT false;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS price_source_note text;
CREATE INDEX IF NOT EXISTS idx_products_restaurant_cuisine_category_sort
  ON public.products (restaurant_id, cuisine, category, is_active, sort_order);

-- Legacy fallback first: retain the cuisine prefix in a separate column and reduce the section label.
UPDATE public.products p
SET cuisine = CASE
      WHEN lower(COALESCE(NULLIF(split_part(p.category,' - ',2),''), p.category,'')) ~ '(papad|salad|dessert|ice cream|shake|frappe|mocktail|iced tea|beverage|drink|lassi|chaas|tea & coffee|soft drinks|cooler)' THEN 'Global'
      WHEN position(' - ' in COALESCE(p.category,'')) > 0 THEN split_part(p.category,' - ',1)
      ELSE COALESCE(NULLIF(p.cuisine,''),'Other') END,
    category = CASE
      WHEN lower(COALESCE(NULLIF(split_part(p.category,' - ',2),''),p.category,'')) ~ 'papad' THEN 'Papad'
      WHEN lower(COALESCE(NULLIF(split_part(p.category,' - ',2),''),p.category,'')) ~ 'salad' THEN 'Salads'
      WHEN lower(COALESCE(NULLIF(split_part(p.category,' - ',2),''),p.category,'')) ~ 'dessert|ice cream' THEN 'Desserts'
      WHEN lower(COALESCE(NULLIF(split_part(p.category,' - ',2),''),p.category,'')) ~ 'tea|coffee|shake|frappe|mocktail|iced tea|beverage|drink|lassi|chaas|cooler|water' THEN 'Beverages'
      WHEN lower(COALESCE(NULLIF(split_part(p.category,' - ',2),''),p.category,'')) ~ 'soup' THEN 'Soups'
      WHEN lower(COALESCE(NULLIF(split_part(p.category,' - ',2),''),p.category,'')) ~ 'salad' THEN 'Salads'
      WHEN lower(COALESCE(NULLIF(split_part(p.category,' - ',2),''),p.category,'')) ~ 'starter|quick bites|tandoor|grill|snack' THEN 'Starters & Tandoor'
      WHEN lower(COALESCE(NULLIF(split_part(p.category,' - ',2),''),p.category,'')) ~ 'platter|sizzler' THEN 'Platters & Sizzlers'
      WHEN lower(COALESCE(NULLIF(split_part(p.category,' - ',2),''),p.category,'')) ~ 'main course|dal|lentil|curry|mexican - mains' THEN 'Main Course'
      WHEN lower(COALESCE(NULLIF(split_part(p.category,' - ',2),''),p.category,'')) ~ 'bread|roti|naan|paratha|rice & biryani|biryani|pulao' THEN 'Breads & Rice'
      WHEN lower(COALESCE(NULLIF(split_part(p.category,' - ',2),''),p.category,'')) ~ 'noodle|fried rice' THEN 'Noodles & Fried Rice'
      WHEN lower(COALESCE(NULLIF(split_part(p.category,' - ',2),''),p.category,'')) ~ 'pasta|pizza|baked|gratin' THEN 'Pasta, Pizza & Bakes'
      ELSE COALESCE(NULLIF(split_part(p.category,' - ',2),''),p.category,'Other') END,
    updated_at=now()
WHERE p.restaurant_id='197ff1e2-dd53-47a4-a5d5-46b3896ac021'::uuid;

CREATE TEMP TABLE _ff_menu_seed (
  name text PRIMARY KEY,
  category text NOT NULL,
  cuisine text NOT NULL,
  price numeric(12,2) NOT NULL CHECK (price >= 0),
  description text NOT NULL,
  source_note text NOT NULL,
  apply_user_price boolean NOT NULL,
  price_review_required boolean NOT NULL,
  sort_order integer NOT NULL
) ON COMMIT DROP;

INSERT INTO _ff_menu_seed(name,category,cuisine,price,description,source_note,apply_user_price,price_review_required,sort_order)
VALUES
('Hot and Sour', 'Soups', 'Chinese', 199.0, 'A lively Chinese-style soup balancing warming spice with a bright, tangy finish.', 'Current database price', FALSE, FALSE, 1),
('Lemon & Coriander', 'Soups', 'Chinese', 229.0, 'A light, refreshing soup with citrusy brightness and fragrant coriander notes.', 'Current database price', FALSE, FALSE, 2),
('Manchow', 'Soups', 'Chinese', 249.0, 'A bold, savoury Indo-Chinese soup with a warming, peppery finish.', 'Current database price', FALSE, FALSE, 3),
('Sweet Corn Soup', 'Soups', 'Chinese', 210.0, 'A gentle, comforting soup with the naturally sweet character of corn.', 'Current database price', FALSE, FALSE, 4),
('Broccoli Almond', 'Soups', 'Continental', 299.0, 'A velvety broccoli soup finished with the delicate, nutty character of almond.', 'Current database price', FALSE, FALSE, 5),
('Creamy Mushroom', 'Soups', 'Continental', 259.0, 'A smooth, comforting mushroom soup with a rich and creamy texture.', 'Current database price', FALSE, FALSE, 6),
('Tomatino', 'Soups', 'Continental', 199.0, 'A comforting tomato-forward soup with a gently tangy finish.', 'Current database price', FALSE, FALSE, 7),
('Corn Salad', 'Salads', 'Global', 225.0, 'A bright, easy-to-enjoy salad featuring the sweet crunch of corn.', 'Current database price', FALSE, FALSE, 8),
('Indian Green Salad', 'Salads', 'Global', 199.0, 'A fresh, crisp assortment of green salad vegetables for a refreshing start.', 'Current database price', FALSE, FALSE, 9),
('Pasta Salad', 'Salads', 'Global', 249.0, 'A chilled, pasta-based salad made for a light and refreshing bite.', 'Current database price', FALSE, FALSE, 10),
('Chilli Paneer Dry/Gravy', 'Starters & Tandoor', 'Chinese', 399.0, 'Paneer in a chilli-forward Indo-Chinese preparation; choose dry or gravy style.', 'Current database price', FALSE, FALSE, 11),
('Corn Salt & Pepper', 'Starters & Tandoor', 'Chinese', 399.0, 'Corn tossed in a peppery seasoning for a crisp, savoury bite.', 'Current database price', FALSE, FALSE, 12),
('Crispy Baby Corn', 'Starters & Tandoor', 'Chinese', 335.0, 'Baby corn cooked to a crisp texture with a savoury seasoning.', 'Current database price', FALSE, FALSE, 13),
('Crispy Mushroom (6 pcs)', 'Starters & Tandoor', 'Chinese', 289.0, 'A crisp mushroom starter listed as a 6-piece portion.', 'Price supplied by user', TRUE, FALSE, 14),
('Crispy Vegetable', 'Starters & Tandoor', 'Chinese', 279.0, 'A crisp vegetable starter with a savoury seasoning.', 'Price supplied by user', TRUE, FALSE, 15),
('Dragon Paneer Chilli Dry (10 pcs)', 'Starters & Tandoor', 'Chinese', 389.0, 'A dry chilli-paneer starter, listed as a 10-piece portion.', 'Price supplied by user', TRUE, FALSE, 16),
('Honey Chilli Potato', 'Starters & Tandoor', 'Chinese', 425.0, 'Potato bites coated in a sweet-and-spicy honey chilli-style sauce.', 'Current database price', FALSE, FALSE, 17),
('Mushroom Chilli Dry', 'Starters & Tandoor', 'Chinese', 279.0, 'Mushrooms in a chilli-forward dry-style Indo-Chinese preparation.', 'Renamed/repriced per user list (was Chilli Mushroom ₹449)', TRUE, FALSE, 18),
('Paneer 65', 'Starters & Tandoor', 'Chinese', 349.0, 'Paneer in a crisp, boldly seasoned 65-style preparation.', 'Current database price', FALSE, FALSE, 19),
('Spring Roll', 'Starters & Tandoor', 'Chinese', 325.0, 'Crisp rolls with a savoury vegetable-style filling.', 'Current database price', FALSE, FALSE, 20),
('Veg 65', 'Starters & Tandoor', 'Chinese', 299.0, 'A crisp, spiced vegetarian bite inspired by the popular 65-style preparation.', 'Current database price', FALSE, FALSE, 21),
('Veg Manchurian Dry', 'Starters & Tandoor', 'Chinese', 389.0, 'Vegetable Manchurian bites tossed in a savoury Indo-Chinese sauce, served dry.', 'Current database price; matched to user-listed Manchurian Dry', FALSE, FALSE, 22),
('Veg Manchurian Gravy', 'Starters & Tandoor', 'Chinese', 449.0, 'Vegetable Manchurian served in a savoury Indo-Chinese gravy.', 'Current database price', FALSE, FALSE, 23),
('Bruschetta Veg', 'Starters & Tandoor', 'Continental', 349.0, 'A crisp, Italian-inspired bread bite topped with a vegetable preparation.', 'Current database price', FALSE, FALSE, 24),
('Cheese Garlic Bread', 'Starters & Tandoor', 'Continental', 315.0, 'Toasted bread with a savoury garlic and cheese topping.', 'Current database price', FALSE, FALSE, 25),
('Cheese Lasagna', 'Starters & Tandoor', 'Continental', 315.0, 'A baked layered pasta dish with a generous cheese-led finish.', 'Current database price', FALSE, FALSE, 26),
('Masala Garlic Bun', 'Starters & Tandoor', 'Continental', 315.0, 'A warm bun with a savoury garlic and Indian masala character.', 'Current database price', FALSE, FALSE, 27),
('Peri Peri Fries', 'Starters & Tandoor', 'Continental', 299.0, 'Crisp fries seasoned with a lively peri-peri-style spice blend.', 'Current database price', FALSE, FALSE, 28),
('Salted French Fries', 'Starters & Tandoor', 'Continental', 259.0, 'Golden fries finished with a simple seasoning of salt.', 'Current database price', FALSE, FALSE, 29),
('Veg Cheese Nuggets (8 pcs)', 'Starters & Tandoor', 'Continental', 329.0, 'Eight crisp vegetable-and-cheese nuggets, ideal for sharing.', 'Current database price', FALSE, FALSE, 30),
('Afghani Chaap Tikka', 'Starters & Tandoor', 'Indian', 299.0, 'Soya chaap prepared in an Afghani-style tikka marinade.', 'Price supplied by user', TRUE, FALSE, 31),
('Afghani Paneer Tikka', 'Starters & Tandoor', 'Indian', 299.0, 'Paneer prepared in Afghani-style tikka seasoning.', 'Price supplied by user', TRUE, FALSE, 32),
('Butter Garlic Mushroom', 'Starters & Tandoor', 'Indian', 410.0, 'Mushrooms tossed in a buttery garlic-style preparation.', 'Current database price', FALSE, FALSE, 33),
('Cheesy Corn Paprika', 'Starters & Tandoor', 'Indian', 415.0, 'A cheesy corn bite with a gentle paprika-led flavour.', 'Current database price', FALSE, FALSE, 34),
('Dahi Ke Kebab', 'Starters & Tandoor', 'Indian', 299.0, 'Soft, creamy dahi-style kebabs with a delicately crisp outer layer.', 'Current database item; placed under Tandoor & Grill', FALSE, FALSE, 35),
('Dahi Ke Sholay', 'Starters & Tandoor', 'Indian', 335.0, 'A crisp, golden snack with a creamy dahi-style centre and a satisfying crunch.', 'Current database price', FALSE, FALSE, 36),
('Hara Bhara Kebab', 'Starters & Tandoor', 'Indian', 359.0, 'A green vegetable kebab with a soft centre and lightly crisp exterior.', 'Current database price', FALSE, FALSE, 37),
('Lahori Chaap Tikka', 'Starters & Tandoor', 'Indian', 319.0, 'Soya chaap prepared in Lahori-style seasoning.', 'Price supplied by user', TRUE, FALSE, 38),
('Lahori Paneer Tikka', 'Starters & Tandoor', 'Indian', 319.0, 'Paneer tikka inspired by Lahori-style seasoning.', 'Price supplied by user', TRUE, FALSE, 39),
('Malai Broccoli', 'Starters & Tandoor', 'Indian', 399.0, 'Broccoli prepared in a mellow, creamy malai-style marinade.', 'Current database price', FALSE, FALSE, 40),
('Malai Chaap Tikka', 'Starters & Tandoor', 'Indian', 289.0, 'Soya chaap prepared in a malai-style tikka marinade.', 'Price supplied by user', TRUE, FALSE, 41),
('Malai Paneer Tikka', 'Starters & Tandoor', 'Indian', 289.0, 'Paneer prepared in a mellow, creamy tikka marinade.', 'Price supplied by user', TRUE, FALSE, 42),
('Malai Soya Chaap', 'Starters & Tandoor', 'Indian', 425.0, 'Soya chaap in a creamy malai-style marinade with a rich finish.', 'Current database price', FALSE, FALSE, 43),
('Mushroom Tikka', 'Starters & Tandoor', 'Indian', 399.0, 'Mushrooms marinated in tandoori-style seasoning and cooked for a roasted finish.', 'Current database price', FALSE, FALSE, 44),
('Mushroom Tikka Tandoori', 'Starters & Tandoor', 'Indian', 299.0, 'Mushrooms prepared in tandoori-style tikka seasoning.', 'Price supplied by user', TRUE, FALSE, 45),
('Pahadi Chaap Tikka', 'Starters & Tandoor', 'Indian', 299.0, 'Soya chaap with a Pahadi-style tikka character.', 'Price supplied by user', TRUE, FALSE, 46),
('Pahadi Paneer Tikka', 'Starters & Tandoor', 'Indian', 299.0, 'Paneer tikka with a Pahadi-style flavour profile.', 'Price supplied by user', TRUE, FALSE, 47),
('Paneer Malai Tikka', 'Starters & Tandoor', 'Indian', 399.0, 'Tender paneer prepared in a mellow, creamy malai-style marinade.', 'Current database price', FALSE, FALSE, 48),
('Paneer Tikka', 'Starters & Tandoor', 'Indian', 375.0, 'Paneer pieces prepared in a tandoori-style marinade and cooked for a smoky, charred finish.', 'Current database price', FALSE, FALSE, 49),
('Sabnam Ke Mushroom', 'Starters & Tandoor', 'Indian', 299.0, 'A mushroom-based tandoor snack; confirm final spelling and preparation.', 'Price supplied by user; confirm name', TRUE, TRUE, 50),
('Smoky Paneer Angara', 'Starters & Tandoor', 'Indian', 399.0, 'Paneer with a bold, smoky character and a robust Indian-style seasoning.', 'Current database price', FALSE, FALSE, 51),
('Tandoori Achari Chaap Tikka', 'Starters & Tandoor', 'Indian', 289.0, 'Tandoori-style chaap with an achari flavour profile.', 'Price supplied by user', TRUE, FALSE, 52),
('Tandoori Achari Paneer Tikka', 'Starters & Tandoor', 'Indian', 289.0, 'Paneer tikka with tandoori and achari-style character.', 'Price supplied by user', TRUE, FALSE, 53),
('Tandoori Chaap Tikka', 'Starters & Tandoor', 'Indian', 289.0, 'Soya chaap prepared in tandoori style.', 'Price supplied by user', TRUE, FALSE, 54),
('Tandoori Najakat', 'Starters & Tandoor', 'Indian', 299.0, 'A signature tandoor-style snack; confirm the exact preparation.', 'Price supplied by user', TRUE, FALSE, 55),
('Tandoori Paneer Tikka', 'Starters & Tandoor', 'Indian', 299.0, 'Paneer tikka prepared in tandoori style.', 'Price supplied by user', TRUE, FALSE, 56),
('Tandoori Soya Chaap', 'Starters & Tandoor', 'Indian', 449.0, 'Soya chaap seasoned in tandoori style for a roasted, smoky bite.', 'Current database price', FALSE, FALSE, 57),
('Cheese Corn Ball with Salsa', 'Starters & Tandoor', 'Mexican', 399.0, 'Crisp cheese-and-corn bites served with salsa-style accompaniment.', 'Current database price', FALSE, FALSE, 58),
('Nachori Nachos', 'Starters & Tandoor', 'Mexican', 359.0, 'A crunchy nacho-style snack with a bold, Mexican-inspired profile.', 'Current database price', FALSE, FALSE, 59),
('Chinese Sizzler', 'Platters & Sizzlers', 'Chinese', 389.0, 'A Chinese-style sizzling platter.', 'Price supplied by user', TRUE, FALSE, 60),
('Chinese Sizzler Mushroom (Noodles or Rice)', 'Platters & Sizzlers', 'Chinese', 289.0, 'Mushroom sizzler served with a choice of noodles or rice.', 'Price supplied by user', TRUE, FALSE, 61),
('Chinese Sizzler Paneer (Noodles or Rice)', 'Platters & Sizzlers', 'Chinese', 289.0, 'Paneer sizzler served with a choice of noodles or rice.', 'Price supplied by user', TRUE, FALSE, 62),
('Veg Sizzler (Manchurian)', 'Platters & Sizzlers', 'Chinese', 649.0, 'A sizzling vegetarian platter featuring a Manchurian-style centrepiece.', 'Current database price', FALSE, FALSE, 63),
('Italian Platter', 'Platters & Sizzlers', 'Continental', 699.0, 'A shareable Italian-inspired selection suited to sampling and sharing.', 'Current database price', FALSE, FALSE, 64),
('Italian Sizzlers', 'Platters & Sizzlers', 'Continental', 759.0, 'A sizzling platter with an Italian-inspired combination.', 'Current database price', FALSE, FALSE, 65),
('Biryani Sizzler (butter naan, papad & kaju)', 'Platters & Sizzlers', 'Indian', 399.0, 'Biryani sizzler served with one butter naan, papad and kaju.', 'Price supplied by user', TRUE, FALSE, 66),
('Chaap Tikka Sizzler & Rice (2 pcs veg seekh)', 'Platters & Sizzlers', 'Indian', 599.0, 'Chaap tikka sizzler served with rice and two pieces of veg seekh.', 'Estimated price — confirm before publishing', FALSE, TRUE, 67),
('Kebab Platter', 'Platters & Sizzlers', 'Indian', 500.0, 'A selection of kebab-style bites, ideal for sharing at the table.', 'Current database price', FALSE, FALSE, 68),
('Mushroom Tikka Sizzler Rice (Najakat 2 pcs)', 'Platters & Sizzlers', 'Indian', 599.0, 'Mushroom tikka sizzler with rice and two Najakat-style pieces.', 'Estimated price — confirm before publishing', FALSE, TRUE, 69),
('Paneer Tikka Sizzler & Rice (2 pcs chaap)', 'Platters & Sizzlers', 'Indian', 599.0, 'Paneer tikka sizzler served with rice and two pieces of chaap.', 'Estimated price — confirm before publishing', FALSE, TRUE, 70),
('Tandoori Platter', 'Platters & Sizzlers', 'Indian', 599.0, 'A shareable selection inspired by classic tandoori flavours.', 'Current database price', FALSE, FALSE, 71),
('Tandoori Sizzler', 'Platters & Sizzlers', 'Indian', 715.0, 'A sizzling platter inspired by smoky tandoori flavours.', 'Current database price', FALSE, FALSE, 72),
('Veg Sizzler (Paneer)', 'Platters & Sizzlers', 'Indian', 649.0, 'A sizzling vegetarian platter with paneer as the centrepiece.', 'Current database price', FALSE, FALSE, 73),
('Achari Dum Aloo', 'Main Course', 'Indian', 349.0, 'Potatoes cooked in a tangy, pickle-spice-inspired curry.', 'Current database price', FALSE, FALSE, 74),
('Chaap Butter Masala', 'Main Course', 'Indian', 449.0, 'Soya chaap in a buttery masala gravy.', 'Estimated price — confirm before publishing', FALSE, TRUE, 75),
('Chaap Roganjosh Masala', 'Main Course', 'Indian', 469.0, 'Soya chaap in a Rogan Josh-style masala.', 'Estimated price — confirm before publishing', FALSE, TRUE, 76),
('Dal Bukhara', 'Main Course', 'Indian', 329.0, 'A rich, slow-style dal inspired by the Bukhara preparation.', 'Estimated price — confirm before publishing', FALSE, TRUE, 77),
('Dal Fry', 'Main Course', 'Indian', 225.0, 'A comforting lentil preparation with a savoury, homestyle finish.', 'Current database price', FALSE, FALSE, 78),
('Dal Hari Bari', 'Main Course', 'Indian', 279.0, 'A green-leaning signature dal with a fresh, herbaceous character.', 'Current database price', FALSE, FALSE, 79),
('Dal Makhani', 'Main Course', 'Indian', 259.0, 'Slow-style black lentils in a creamy, buttery gravy.', 'Current database price', FALSE, FALSE, 80),
('Dal Pudina', 'Main Course', 'Indian', 249.0, 'Lentils with a fresh mint-led flavour.', 'Current database price', FALSE, FALSE, 81),
('Dal Tadka', 'Main Course', 'Indian', 299.0, 'Lentils finished with a fragrant Indian-style tadka.', 'Current database price', FALSE, FALSE, 82),
('Dhaniya Adrakhi', 'Main Course', 'Indian', 389.0, 'A signature curry described by its coriander-and-ginger style; confirm the base ingredient.', 'Estimated price — confirm dish base and price', FALSE, TRUE, 83),
('Gatta Curry', 'Main Course', 'Indian', 329.0, 'A Rajasthani-style gatta curry.', 'Estimated price — confirm before publishing', FALSE, TRUE, 84),
('Handi Paneer', 'Main Course', 'Indian', 349.0, 'Paneer cooked in a handi-style curry with a rounded, homestyle character.', 'Current database price', FALSE, FALSE, 85),
('Kadai Paneer', 'Main Course', 'Indian', 338.0, 'Paneer in a robust kadai-style masala with a savoury, aromatic finish.', 'Current database price', FALSE, FALSE, 86),
('Kadhai Chaap', 'Main Course', 'Indian', 449.0, 'Soya chaap in a kadhai-style masala.', 'Estimated price — confirm before publishing', FALSE, TRUE, 87),
('Kadhi', 'Main Course', 'Indian', 299.0, 'A kadhi-style curry served as a main-course option.', 'Estimated price — confirm before publishing', FALSE, TRUE, 88),
('Kaju Curry', 'Main Course', 'Indian', 499.0, 'Cashews in a rich Indian-style curry with a mellow, indulgent finish.', 'Current database price', FALSE, FALSE, 89),
('Kaju Masala', 'Main Course', 'Indian', 499.0, 'Cashews in a rich masala-style curry.', 'Estimated price — confirm before publishing', FALSE, TRUE, 90),
('Kebab Curry', 'Main Course', 'Indian', 389.0, 'A curry featuring kebab-style preparation; confirm the exact base.', 'Estimated price — confirm before publishing', FALSE, TRUE, 91),
('Long Latta', 'Main Course', 'Indian', 389.0, 'Signature-style main course; confirm the dish name and preparation.', 'Estimated price — confirm name and price', FALSE, TRUE, 92),
('Malai Kofta', 'Main Course', 'Indian', 499.0, 'Soft kofta dumplings served in a rich, creamy curry.', 'Current database price', FALSE, FALSE, 93),
('Matar Mushroom', 'Main Course', 'Indian', 425.0, 'Green peas and mushrooms cooked in a savoury Indian gravy.', 'Current database price', FALSE, FALSE, 94),
('Matar Paneer', 'Main Course', 'Indian', 425.0, 'Paneer and green peas in a classic Indian curry.', 'Current database price', FALSE, FALSE, 95),
('Mix Vegetable', 'Main Course', 'Indian', 349.0, 'A seasonal-style mix of vegetables cooked in an Indian masala.', 'Current database price', FALSE, FALSE, 96),
('Mushroom Butter Masala', 'Main Course', 'Indian', 435.0, 'Mushrooms in a buttery masala gravy.', 'Estimated price — confirm before publishing', FALSE, TRUE, 97),
('Mushroom Kadhai', 'Main Course', 'Indian', 435.0, 'Mushrooms in a kadhai-style masala gravy.', 'Estimated price — confirm before publishing', FALSE, TRUE, 98),
('Mushroom Masala', 'Main Course', 'Indian', 435.0, 'Mushrooms simmered in a flavourful Indian masala curry.', 'Current database price', FALSE, FALSE, 99),
('Mushroom Rogan Josh', 'Main Course', 'Indian', 449.0, 'A mushroom-based curry described in a Rogan Josh style.', 'Estimated price — confirm before publishing', FALSE, TRUE, 100),
('Mushroom Tikka Masala', 'Main Course', 'Indian', 435.0, 'Mushrooms in a tikka-style masala gravy.', 'Estimated price — confirm before publishing', FALSE, TRUE, 101),
('Palak Paneer', 'Main Course', 'Indian', 415.0, 'Paneer paired with a smooth spinach-based curry.', 'Current database price', FALSE, FALSE, 102),
('Paneer Angara', 'Main Course', 'Indian', 329.0, 'Paneer in a bold, smoky and spice-forward Indian curry.', 'Current database price', FALSE, FALSE, 103),
('Paneer Butter Masala', 'Main Course', 'Indian', 415.0, 'Paneer in a creamy, buttery tomato-style gravy.', 'Current database price', FALSE, FALSE, 104),
('Paneer Lababdar', 'Main Course', 'Indian', 389.0, 'Paneer in a rich, indulgent North Indian-style gravy.', 'Current database price', FALSE, FALSE, 105),
('Paneer Pasanda', 'Main Course', 'Indian', 359.0, 'Paneer in a rich, mellow curry inspired by the classic pasanda style.', 'Current database price', FALSE, FALSE, 106),
('Paneer Patiala', 'Main Course', 'Indian', 315.0, 'Paneer in a rich, North Indian-style curry with a full-bodied flavour.', 'Current database price', FALSE, FALSE, 107),
('Paneer Tikka Masala', 'Main Course', 'Indian', 415.0, 'Tandoori-style paneer served in a rich, spiced masala gravy.', 'Current database price', FALSE, FALSE, 108),
('Pindi Chole', 'Main Course', 'Indian', 335.0, 'Chickpeas in a robust Punjabi-style masala with a deep, spiced flavour.', 'Current database price', FALSE, FALSE, 109),
('Punjabi Dal Tadka', 'Main Course', 'Indian', 299.0, 'A Punjabi-style dal finished with a fragrant tadka.', 'Estimated price — confirm before publishing', FALSE, TRUE, 110),
('Raj Shahi Dal', 'Main Course', 'Indian', 299.0, 'A rich, royal-style dal with a full-bodied finish.', 'Current database price', FALSE, FALSE, 111),
('Shahi Chaap', 'Main Course', 'Indian', 449.0, 'Soya chaap in a rich shahi-style gravy.', 'Estimated price — confirm before publishing', FALSE, TRUE, 112),
('Shahi Masala', 'Main Course', 'Indian', 399.0, 'Shahi-style curry; the main ingredient needs confirmation.', 'Estimated price — confirm dish base and price', FALSE, TRUE, 113),
('Shahi Paneer', 'Main Course', 'Indian', 389.0, 'Paneer in a rich, shahi-style curry.', 'Estimated price — confirm before publishing', FALSE, TRUE, 114),
('Soya Chaap Masala', 'Main Course', 'Indian', 449.0, 'Soya chaap served in a rich, spiced masala gravy.', 'Current database price', FALSE, FALSE, 115),
('Tawa Sabzi', 'Main Course', 'Indian', 415.0, 'A medley of vegetables cooked tawa-style with Indian seasoning.', 'Current database price', FALSE, FALSE, 116),
('Burrito', 'Main Course', 'Mexican', 425.0, 'A hearty Mexican-inspired wrap-style meal with a savoury filling.', 'Current database price', FALSE, FALSE, 117),
('Quesadillas', 'Main Course', 'Mexican', 399.0, 'A Mexican-inspired griddled tortilla dish with a savoury filling.', 'Current database price', FALSE, FALSE, 118),
('Amritsari Kulcha', 'Breads & Rice', 'Indian', 119.0, 'A Punjabi-style kulcha, served with the main meal.', 'Price supplied by user', TRUE, FALSE, 119),
('Butter Chapatti', 'Breads & Rice', 'Indian', 49.0, 'Chapatti finished with butter for a softer, richer bite.', 'Current database price', FALSE, FALSE, 120),
('Butter Naan', 'Breads & Rice', 'Indian', 109.0, 'Soft naan brushed with butter.', 'Current database price', FALSE, FALSE, 121),
('Butter Tandoori Roti', 'Breads & Rice', 'Indian', 49.0, 'Tandoor-baked roti finished with butter.', 'Current database price', FALSE, FALSE, 122),
('Chaap Tikka Biryani', 'Breads & Rice', 'Indian', 329.0, 'Biryani-style rice featuring chaap tikka.', 'Price supplied by user', TRUE, FALSE, 123),
('Chapatti', 'Breads & Rice', 'Indian', 39.0, 'A simple, everyday Indian flatbread.', 'Current database price', FALSE, FALSE, 124),
('Cheese Naan', 'Breads & Rice', 'Indian', 169.0, 'Naan with a cheese-filled or cheese-topped finish.', 'Current database price', FALSE, FALSE, 125),
('ChurChur Naan', 'Breads & Rice', 'Indian', 129.0, 'A layered, crisp-edged naan-style bread.', 'Price supplied by user', TRUE, FALSE, 126),
('Dhaniya Roti', 'Breads & Rice', 'Indian', 89.0, 'Indian flatbread finished with fragrant coriander notes.', 'Current database price', FALSE, FALSE, 127),
('Garlic Naan', 'Breads & Rice', 'Indian', 139.0, 'Naan finished with a savoury garlic flavour.', 'Current database price', FALSE, FALSE, 128),
('Jeera Rice', 'Breads & Rice', 'Indian', 279.0, 'Rice tempered with fragrant cumin for a warm, aromatic finish.', 'Current database price', FALSE, FALSE, 129),
('Kulcha', 'Breads & Rice', 'Indian', 89.0, 'A soft Indian bread made to pair with curries and dals.', 'Current database price', FALSE, FALSE, 130),
('Lachha Paratha', 'Breads & Rice', 'Indian', 110.0, 'A layered Indian flatbread with a flaky texture.', 'Current database price', FALSE, FALSE, 131),
('Missi Roti', 'Breads & Rice', 'Indian', 70.0, 'A traditional missi-style roti with a hearty, rustic character.', 'Updated to user-provided price (was ₹99)', TRUE, FALSE, 132),
('Mushroom Tikka Biryani', 'Breads & Rice', 'Indian', 329.0, 'Biryani-style rice featuring mushroom tikka.', 'Price supplied by user', TRUE, FALSE, 133),
('Paneer Tikka Biryani', 'Breads & Rice', 'Indian', 329.0, 'Biryani-style rice featuring paneer tikka.', 'Price supplied by user', TRUE, FALSE, 134),
('Plain Naan', 'Breads & Rice', 'Indian', 70.0, 'A soft, tandoor-baked naan to pair with curries.', 'Updated to user-provided price (was ₹99)', TRUE, FALSE, 135),
('Steamed Rice', 'Breads & Rice', 'Indian', 249.0, 'Plain steamed rice, a versatile accompaniment to Indian curries.', 'Current database price', FALSE, FALSE, 136),
('Stove Naan', 'Breads & Rice', 'Indian', 119.0, 'A naan-style bread prepared on the stove.', 'Price supplied by user; confirm dish name', TRUE, TRUE, 137),
('Tandoori Roti', 'Breads & Rice', 'Indian', 39.0, 'A classic tandoor-baked Indian flatbread.', 'Current database price', FALSE, FALSE, 138),
('Veg Biryani', 'Breads & Rice', 'Indian', 389.0, 'A layered, aromatic vegetable biryani with Indian spices.', 'Current database price', FALSE, FALSE, 139),
('Veg Hyderabadi Biryani', 'Breads & Rice', 'Indian', 299.0, 'A Hyderabadi-inspired biryani with aromatic spices and a bold rice flavour.', 'Standardized name and updated to user-provided price (was ₹399)', TRUE, FALSE, 140),
('Veg Pulao', 'Breads & Rice', 'Indian', 319.0, 'Fragrant rice cooked with vegetables and mild spices.', 'Current database price', FALSE, FALSE, 141),
('Chilli Garlic Fried Rice', 'Noodles & Fried Rice', 'Chinese', 289.0, 'Rice tossed with vegetables and a lively chilli-garlic flavour.', 'Renamed/repriced per user list (was Veg Chilli Garlic Rice ₹349)', TRUE, FALSE, 142),
('Chilli Garlic Noodles', 'Noodles & Fried Rice', 'Chinese', 289.0, 'Noodles tossed with a bold chilli-garlic flavour.', 'Updated to user-provided price (was ₹319)', TRUE, FALSE, 143),
('Hong Kong Fried Rice', 'Noodles & Fried Rice', 'Chinese', 279.0, 'Fried rice prepared in a Hong Kong-style flavour profile.', 'Price supplied by user', TRUE, FALSE, 144),
('Hong Kong Noodles', 'Noodles & Fried Rice', 'Chinese', 279.0, 'Noodles prepared in a Hong Kong-style flavour profile.', 'Price supplied by user', TRUE, FALSE, 145),
('Paneer Fried Rice', 'Noodles & Fried Rice', 'Chinese', 370.0, 'Fried rice with paneer for a hearty Indo-Chinese option.', 'Current database price', FALSE, FALSE, 146),
('Singapore Noodles', 'Noodles & Fried Rice', 'Chinese', 279.0, 'Noodles prepared in a Singapore-style flavour profile.', 'Price supplied by user', TRUE, FALSE, 147),
('Veg Fried Rice', 'Noodles & Fried Rice', 'Chinese', 349.0, 'Rice wok-tossed in a savoury Indo-Chinese style with vegetables.', 'Current database price', FALSE, FALSE, 148),
('Veg Hakka Noodles', 'Noodles & Fried Rice', 'Chinese', 339.0, 'Indo-Chinese-style noodles tossed with vegetables and savoury seasoning.', 'Current database price', FALSE, FALSE, 149),
('Veg Schezwan Noodles', 'Noodles & Fried Rice', 'Chinese', 349.0, 'Vegetable noodles with the punchy heat of Schezwan-style seasoning.', 'Current database price', FALSE, FALSE, 150),
('Veg Schezwan Rice', 'Noodles & Fried Rice', 'Chinese', 350.0, 'Vegetable fried rice with bold Schezwan-style seasoning.', 'Current database price', FALSE, FALSE, 151),
('Alfredo Pasta', 'Pasta, Pizza & Bakes', 'Continental', 399.0, 'Pasta in a smooth, creamy Alfredo-style sauce.', 'Current database price', FALSE, FALSE, 152),
('Arrabbiata', 'Pasta, Pizza & Bakes', 'Continental', 425.0, 'Pasta in a bold tomato-based sauce with a lively chilli kick.', 'Current database price', FALSE, FALSE, 153),
('Baked Veg', 'Pasta, Pizza & Bakes', 'Continental', 399.0, 'A comforting baked vegetable dish with a warm, oven-finished top.', 'Current database price', FALSE, FALSE, 154),
('Gattu Gratin', 'Pasta, Pizza & Bakes', 'Continental', 425.0, 'A signature gratin-style bake with a warm, savoury finish.', 'Current database price', FALSE, FALSE, 155),
('Jamaican Pizza', 'Pasta, Pizza & Bakes', 'Continental', 425.0, 'A signature pizza with a bold, island-inspired flavour profile.', 'Current database price', FALSE, FALSE, 156),
('Mac and Cheese', 'Pasta, Pizza & Bakes', 'Continental', 489.0, 'Pasta coated in a creamy cheese sauce and baked-style comfort.', 'Current database price', FALSE, FALSE, 157),
('Margarita', 'Pasta, Pizza & Bakes', 'Continental', 399.0, 'A classic-style pizza with a simple, cheese-forward profile.', 'Current database price', FALSE, FALSE, 158),
('Mushroom Pizza', 'Pasta, Pizza & Bakes', 'Continental', 425.0, 'Pizza topped with mushrooms for an earthy, savoury finish.', 'Current database price', FALSE, FALSE, 159),
('Onion & Capsicum Pizza', 'Pasta, Pizza & Bakes', 'Continental', 399.0, 'Pizza topped with onion and capsicum for a crisp, savoury bite.', 'Current database price', FALSE, FALSE, 160),
('Paneer Pizza', 'Pasta, Pizza & Bakes', 'Continental', 425.0, 'Pizza topped with paneer for an Indian-inspired twist.', 'Current database price', FALSE, FALSE, 161),
('Pink City Pasta', 'Pasta, Pizza & Bakes', 'Continental', 489.0, 'A signature pasta named for the Pink City, prepared as a rich, flavourful main.', 'Current database price', FALSE, FALSE, 162),
('Spaghetti Aglio e Olio', 'Pasta, Pizza & Bakes', 'Continental', 425.0, 'Spaghetti in an Italian-style garlic and olive-oil preparation.', 'Current database price', FALSE, FALSE, 163),
('Spaghetti Al Pesto', 'Pasta, Pizza & Bakes', 'Continental', 429.0, 'Spaghetti coated in a fragrant pesto-style sauce.', 'Current database price', FALSE, FALSE, 164),
('Tabasco 360 Pizza', 'Pasta, Pizza & Bakes', 'Continental', 415.0, 'A signature pizza for guests who enjoy a bold, tangy chilli-style kick.', 'Current database price', FALSE, FALSE, 165),
('Veggie Delight', 'Pasta, Pizza & Bakes', 'Continental', 399.0, 'A vegetable-forward pasta with a balanced, savoury finish.', 'Current database price', FALSE, FALSE, 166),
('Your Pizza Choice', 'Pasta, Pizza & Bakes', 'Continental', 425.0, 'A customisable pizza prepared with your preferred available choices.', 'Current database price', FALSE, FALSE, 167),
('Fried Masala Papad', 'Papad', 'Global', 89.0, 'Crisp fried papad finished with a punchy masala seasoning.', 'Current database price', FALSE, FALSE, 168),
('Fried Papad', 'Papad', 'Global', 59.0, 'A crisp, golden-fried papad served as a classic accompaniment.', 'Current database price', FALSE, FALSE, 169),
('Roasted Masala Papad with Cheese', 'Papad', 'Global', 99.0, 'Crisp roasted papad topped with masala seasoning and cheese.', 'Current database price', FALSE, FALSE, 170),
('Roasted Papad (1 Qty.)', 'Papad', 'Global', 49.0, 'A single roasted papad, light and crisp alongside your meal.', 'Current database price', FALSE, FALSE, 171),
('Gulab Jamun with Ice Cream', 'Desserts', 'Global', 249.0, 'Soft gulab jamun served with ice cream for a warm-and-cold dessert pairing.', 'Current database price', FALSE, FALSE, 172),
('Ice Cream', 'Desserts', 'Global', 149.0, 'A chilled dessert for a simple, sweet finish.', 'Current database price', FALSE, FALSE, 173),
('Shahi Kheer', 'Desserts', 'Global', 325.0, 'A rich, traditional-style kheer served as an indulgent dessert.', 'Current database price', FALSE, FALSE, 174),
('Sizzling Brownie with Ice-Cream', 'Desserts', 'Global', 325.0, 'A warm brownie served sizzling with a cool scoop of ice cream.', 'Current database price', FALSE, FALSE, 175),
('4 Flavoursome Magnifero', 'Beverages', 'Global', 241.0, 'A house-signature mocktail with a distinctive, fruit-forward character.', 'Current database price', FALSE, FALSE, 176),
('Atrangi Yaari', 'Beverages', 'Global', 232.0, 'A playful house-signature cooler with a distinctive flavour profile.', 'Current database price', FALSE, FALSE, 177),
('Banoffee Shake', 'Beverages', 'Global', 268.0, 'A dessert-style shake inspired by banana and toffee flavours.', 'Current database price', FALSE, FALSE, 178),
('Beated Betel', 'Beverages', 'Global', 268.0, 'A distinctive signature shake inspired by betel-style aromatic flavours.', 'Current database price', FALSE, FALSE, 179),
('Berry Basil', 'Beverages', 'Global', 298.0, 'A fruity mocktail pairing berry notes with aromatic basil.', 'Current database price', FALSE, FALSE, 180),
('Blue Lagoon', 'Beverages', 'Global', 241.0, 'A bright blue mocktail with a citrus-style finish.', 'Current database price', FALSE, FALSE, 181),
('Blue Sky', 'Beverages', 'Global', 223.0, 'A colourful signature cooler with a refreshing, bright finish.', 'Current database price', FALSE, FALSE, 182),
('Brownie Shake', 'Beverages', 'Global', 299.0, 'A creamy shake inspired by the rich taste of brownie dessert.', 'Current database price', FALSE, FALSE, 183),
('Buttermilk', 'Beverages', 'Global', 69.0, 'A cooling, savoury buttermilk drink.', 'Current database price', FALSE, FALSE, 184),
('Caramel Popcorn Shake', 'Beverages', 'Global', 289.0, 'A dessert-style shake inspired by sweet caramel popcorn.', 'Current database price', FALSE, FALSE, 185),
('Chamatkar (Special)', 'Beverages', 'Global', 328.0, 'A house-signature shake with a distinctive, indulgent character.', 'Current database price', FALSE, FALSE, 186),
('Chemical Locha', 'Beverages', 'Global', 289.0, 'A playful signature mocktail with a bold, distinctive character.', 'Current database price', FALSE, FALSE, 187),
('Choco Frappe', 'Beverages', 'Global', 249.0, 'A chilled chocolate frappe with a smooth, blended finish.', 'Current database price', FALSE, FALSE, 188),
('Chocolate Banana Shake', 'Beverages', 'Global', 268.0, 'A smooth shake combining chocolate-style and banana flavours.', 'Current database price', FALSE, FALSE, 189),
('Chocolate Cookie Shake', 'Beverages', 'Global', 289.0, 'A creamy shake inspired by chocolate cookies.', 'Current database price', FALSE, FALSE, 190),
('Chocolate Mint Shake', 'Beverages', 'Global', 259.0, 'A chilled, creamy shake pairing chocolate notes with a cool mint finish.', 'Current database price', FALSE, FALSE, 191),
('Chuski (Our Signature)', 'Beverages', 'Global', 248.0, 'The house-signature Chuski: a playful, cooling finish to a meal.', 'Current database price', FALSE, FALSE, 192),
('Citric Zest', 'Beverages', 'Global', 278.0, 'A bright, citrus-forward mocktail with a zesty finish.', 'Current database price', FALSE, FALSE, 193),
('Cold Coffee Plain', 'Beverages', 'Global', 219.0, 'Chilled coffee blended for a smooth, refreshing coffee hit.', 'Current database price', FALSE, FALSE, 194),
('Cold Coffee with Ice Cream', 'Beverages', 'Global', 269.0, 'Chilled coffee served with ice cream for a creamy dessert-style drink.', 'Current database price', FALSE, FALSE, 195),
('Cucumber Lemonade', 'Beverages', 'Global', 248.0, 'A cooling lemonade with fresh cucumber-style notes.', 'Current database price', FALSE, FALSE, 196),
('Ferrero Rocher Shake', 'Beverages', 'Global', 349.0, 'A rich chocolate-and-hazelnut-inspired shake.', 'Current database price', FALSE, FALSE, 197),
('Foxy People''s Obsession', 'Beverages', 'Global', 279.0, 'A house-signature shake with a playful name and dessert-style finish.', 'Current database price', FALSE, FALSE, 198),
('Green Apple Mojito', 'Beverages', 'Global', 229.0, 'A refreshing mocktail with green-apple character and a minty citrus-style finish.', 'Current database price', FALSE, FALSE, 199),
('Gulabo', 'Beverages', 'Global', 258.0, 'A signature shake with a sweet, dessert-style character.', 'Current database price', FALSE, FALSE, 200),
('Icy Frappe', 'Beverages', 'Global', 269.0, 'A chilled blended frappe with a refreshing finish.', 'Current database price', FALSE, FALSE, 201),
('Imliya', 'Beverages', 'Global', 238.0, 'A tangy signature cooler inspired by tamarind-style flavours.', 'Current database price', FALSE, FALSE, 202),
('Italian Smooch', 'Beverages', 'Global', 289.0, 'A signature mocktail with a bright, Italian-inspired profile.', 'Current database price', FALSE, FALSE, 203),
('Jaipuri Lassi', 'Beverages', 'Global', 99.0, 'A chilled lassi with a signature Jaipuri touch.', 'Current database price', FALSE, FALSE, 204),
('Jhakkas', 'Beverages', 'Global', 219.0, 'A lively house-signature mocktail with a refreshing finish.', 'Current database price', FALSE, FALSE, 205),
('King of Fruits (Mango Based Shake)', 'Beverages', 'Global', 219.0, 'A mango-based shake celebrating the king of fruits.', 'Current database price', FALSE, FALSE, 206),
('King-Killer', 'Beverages', 'Global', 289.0, 'A bold house-signature shake with a rich, indulgent profile.', 'Current database price', FALSE, FALSE, 207),
('Kingdom of Guava', 'Beverages', 'Global', 239.0, 'A fruity signature cooler with guava-led flavour.', 'Current database price', FALSE, FALSE, 208),
('Lemon Ice Tea', 'Beverages', 'Global', 232.0, 'Chilled iced tea with a bright lemon finish.', 'Current database price', FALSE, FALSE, 209),
('Lotus Biscoff Shake', 'Beverages', 'Global', 249.0, 'A creamy shake inspired by the caramelised biscuit flavour of Lotus Biscoff.', 'Current database price', FALSE, FALSE, 210),
('Love Dose', 'Beverages', 'Global', 219.0, 'A house-signature mocktail with a bright, celebratory character.', 'Current database price', FALSE, FALSE, 211),
('Mango Banana Shake', 'Beverages', 'Global', 269.0, 'A creamy fruit shake pairing mango and banana flavours.', 'Current database price', FALSE, FALSE, 212),
('Masala Cola', 'Beverages', 'Global', 219.0, 'A familiar cola-style drink with an Indian masala twist.', 'Current database price', FALSE, FALSE, 213),
('Masala Lemonade', 'Beverages', 'Global', 238.0, 'Lemonade with a lively Indian masala seasoning.', 'Current database price', FALSE, FALSE, 214),
('Mineral Water', 'Beverages', 'Global', 20.0, 'Bottled mineral water for refreshment.', 'Current database price', FALSE, FALSE, 215),
('Mojito Coffee Magnifero', 'Beverages', 'Global', 241.0, 'A signature chilled drink combining coffee character with a mojito-inspired twist.', 'Current database price', FALSE, FALSE, 216),
('Muddy Oreo', 'Beverages', 'Global', 289.0, 'A rich, cookie-inspired chocolate shake with an indulgent finish.', 'Current database price', FALSE, FALSE, 217),
('Nawab-e-Shaan', 'Beverages', 'Global', 289.0, 'A house-signature shake with a rich, royal-style character.', 'Current database price', FALSE, FALSE, 218),
('Nutella Shake', 'Beverages', 'Global', 249.0, 'A creamy shake inspired by Nutella’s chocolate-hazelnut flavour.', 'Current database price', FALSE, FALSE, 219),
('Passion Fruit Elderflower', 'Beverages', 'Global', 308.0, 'A fragrant mocktail combining tropical passion-fruit character with floral notes.', 'Current database price', FALSE, FALSE, 220),
('Peach Ice Tea', 'Beverages', 'Global', 258.0, 'Chilled iced tea with a delicate peach flavour.', 'Current database price', FALSE, FALSE, 221),
('Pina Colada', 'Beverages', 'Global', 219.0, 'A tropical-style mocktail with a creamy, fruity profile.', 'Current database price', FALSE, FALSE, 222),
('Special Hot Coffee', 'Beverages', 'Global', 79.0, 'A freshly prepared hot coffee with a comforting, aromatic finish.', 'Current database price', FALSE, FALSE, 223),
('Special Tea', 'Beverages', 'Global', 59.0, 'A comforting cup of specially prepared tea.', 'Current database price', FALSE, FALSE, 224),
('Strawberry Ice Tea', 'Beverages', 'Global', 288.0, 'Chilled iced tea with a fruity strawberry finish.', 'Current database price', FALSE, FALSE, 225),
('Strawberry Mojito', 'Beverages', 'Global', 268.0, 'A fruity, non-alcoholic mojito-style drink with strawberry notes.', 'Current database price', FALSE, FALSE, 226),
('Strawberry Shake', 'Beverages', 'Global', 270.0, 'A chilled, creamy shake with strawberry flavour.', 'Current database price', FALSE, FALSE, 227),
('The Pink City Special Shake', 'Beverages', 'Global', 289.0, 'A house-signature shake inspired by the Pink City.', 'Current database price', FALSE, FALSE, 228),
('Vanilla Shake', 'Beverages', 'Global', 189.0, 'A smooth, classic vanilla-flavoured shake.', 'Current database price', FALSE, FALSE, 229),
('Virgin Mojito', 'Beverages', 'Global', 199.0, 'A refreshing non-alcoholic mojito-style drink with mint and citrus character.', 'Current database price', FALSE, FALSE, 230),
('Watermelon Spritzer', 'Beverages', 'Global', 270.0, 'A light, refreshing watermelon-style spritzer.', 'Current database price', FALSE, FALSE, 231);

DO $alias_fix$
BEGIN
  -- Rename/reprice the three exact old names explicitly superseded in the approved menu.
  IF EXISTS (SELECT 1 FROM public.products WHERE restaurant_id='197ff1e2-dd53-47a4-a5d5-46b3896ac021'::uuid AND lower(name)='chilli mushroom') THEN
    IF NOT EXISTS (SELECT 1 FROM public.products WHERE restaurant_id='197ff1e2-dd53-47a4-a5d5-46b3896ac021'::uuid AND lower(name)='mushroom chilli dry') THEN
      UPDATE public.products SET name='Mushroom Chilli Dry',price=279,updated_at=now()
      WHERE restaurant_id='197ff1e2-dd53-47a4-a5d5-46b3896ac021'::uuid AND lower(name)='chilli mushroom';
    ELSE
      UPDATE public.products SET is_active=false,updated_at=now()
      WHERE restaurant_id='197ff1e2-dd53-47a4-a5d5-46b3896ac021'::uuid AND lower(name)='chilli mushroom';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.products WHERE restaurant_id='197ff1e2-dd53-47a4-a5d5-46b3896ac021'::uuid AND lower(name)='veg chilli garlic rice') THEN
    IF NOT EXISTS (SELECT 1 FROM public.products WHERE restaurant_id='197ff1e2-dd53-47a4-a5d5-46b3896ac021'::uuid AND lower(name)='chilli garlic fried rice') THEN
      UPDATE public.products SET name='Chilli Garlic Fried Rice',price=289,updated_at=now()
      WHERE restaurant_id='197ff1e2-dd53-47a4-a5d5-46b3896ac021'::uuid AND lower(name)='veg chilli garlic rice';
    ELSE
      UPDATE public.products SET is_active=false,updated_at=now()
      WHERE restaurant_id='197ff1e2-dd53-47a4-a5d5-46b3896ac021'::uuid AND lower(name)='veg chilli garlic rice';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.products WHERE restaurant_id='197ff1e2-dd53-47a4-a5d5-46b3896ac021'::uuid AND lower(name)='hyderabadi biryani') THEN
    IF NOT EXISTS (SELECT 1 FROM public.products WHERE restaurant_id='197ff1e2-dd53-47a4-a5d5-46b3896ac021'::uuid AND lower(name)='veg hyderabadi biryani') THEN
      UPDATE public.products SET name='Veg Hyderabadi Biryani',price=299,updated_at=now()
      WHERE restaurant_id='197ff1e2-dd53-47a4-a5d5-46b3896ac021'::uuid AND lower(name)='hyderabadi biryani';
    ELSE
      UPDATE public.products SET is_active=false,updated_at=now()
      WHERE restaurant_id='197ff1e2-dd53-47a4-a5d5-46b3896ac021'::uuid AND lower(name)='hyderabadi biryani';
    END IF;
  END IF;
END;
$alias_fix$;

-- Update existing rows in place (product UUIDs, images, recipe links and order snapshots remain intact).
UPDATE public.products p SET
  name=s.name,
  cuisine=s.cuisine,
  category=s.category,
  price=CASE WHEN s.apply_user_price THEN s.price ELSE p.price END,
  description=CASE WHEN NULLIF(btrim(COALESCE(p.description,'')),'') IS NULL THEN s.description ELSE p.description END,
  sort_order=s.sort_order,
  is_active=true,
  price_source_note=s.source_note,
  price_review_required=s.price_review_required,
  updated_at=now()
FROM _ff_menu_seed s
WHERE p.restaurant_id='197ff1e2-dd53-47a4-a5d5-46b3896ac021'::uuid
  AND lower(btrim(p.name))=lower(btrim(s.name));

-- Insert only missing rows from the approved workbook. Existing names are never duplicated.
INSERT INTO public.products(
  restaurant_id,name,description,category,cuisine,price,tax_exempt,image_url,is_active,
  sort_order,is_veg,price_review_required,price_source_note
)
SELECT
  '197ff1e2-dd53-47a4-a5d5-46b3896ac021'::uuid,
  s.name,s.description,s.category,s.cuisine,s.price,false,NULL,true,
  s.sort_order,true,s.price_review_required,s.source_note
FROM _ff_menu_seed s
WHERE NOT EXISTS (
  SELECT 1 FROM public.products p
  WHERE p.restaurant_id='197ff1e2-dd53-47a4-a5d5-46b3896ac021'::uuid
    AND lower(btrim(p.name))=lower(btrim(s.name))
);

-- Ensure remaining non-workbook rows (for example the inactive, unpriced Aerated Drink) keep a safe taxonomy.
UPDATE public.products p SET
  cuisine=CASE
    WHEN lower(COALESCE(p.category,'')) IN ('papad','salads','desserts','beverages') THEN 'Global'
    WHEN p.cuisine IS NOT NULL AND btrim(p.cuisine)<>'' THEN p.cuisine
    ELSE 'Other' END,
  category=CASE
    WHEN lower(COALESCE(p.category,'')) ~ 'papad' THEN 'Papad'
    WHEN lower(COALESCE(p.category,'')) ~ 'salad' THEN 'Salads'
    WHEN lower(COALESCE(p.category,'')) ~ 'dessert|ice cream' THEN 'Desserts'
    WHEN lower(COALESCE(p.category,'')) ~ 'beverage|drink|water|shake|frappe|mocktail|tea|coffee|cooler|lassi|chaas' THEN 'Beverages'
    ELSE p.category END
WHERE p.restaurant_id='197ff1e2-dd53-47a4-a5d5-46b3896ac021'::uuid
  AND NOT EXISTS (SELECT 1 FROM _ff_menu_seed s WHERE lower(s.name)=lower(p.name));

CREATE OR REPLACE FUNCTION public.admin_mutate_resource(
  p_panel_token text,
  p_resource text,
  p_action text,
  p_record_id uuid,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $function$
DECLARE
  v_restaurant_id uuid;
  v_id uuid;
  v_record jsonb;
  v_name text;
  v_price numeric;
  v_table_no text;
  v_capacity integer;
  v_is_active boolean;
  v_bg text;
  v_fg text;
  v_url text;
BEGIN
  SELECT x.restaurant_id INTO v_restaurant_id
  FROM public._tableforge_validate_panel_token(p_panel_token, ARRAY['admin']) x;
  IF v_restaurant_id IS NULL THEN RAISE EXCEPTION 'Admin panel authorization expired or invalid.'; END IF;
  IF p_resource NOT IN ('products','cuisines','tables','settings','branding') THEN RAISE EXCEPTION 'Unsupported resource.'; END IF;
  IF p_action NOT IN ('insert','update','delete','save') THEN RAISE EXCEPTION 'Unsupported action.'; END IF;
  v_id := COALESCE(p_record_id, NULLIF(p_payload->>'id','')::uuid, gen_random_uuid());

  IF p_resource='products' THEN
    IF p_action='delete' THEN
      UPDATE public.products SET is_active=false, updated_at=now()
      WHERE id=v_id AND restaurant_id=v_restaurant_id
      RETURNING to_jsonb(products) INTO v_record;
      IF v_record IS NULL THEN RAISE EXCEPTION 'Product not found.'; END IF;
    ELSIF p_action IN ('insert','update') THEN
      v_name := btrim(COALESCE(p_payload->>'name',''));
      v_price := NULLIF(p_payload->>'price','')::numeric;
      IF v_name='' OR length(v_name)>160 OR v_price IS NULL OR v_price<0 THEN
        RAISE EXCEPTION 'Product name and non-negative price are required.';
      END IF;
      IF p_action='insert' THEN
        INSERT INTO public.products(
          id, restaurant_id, name, description, category, cuisine, price, tax_exempt,
          image_url, is_active, sort_order, created_by, is_veg,
          price_review_required, price_source_note
        )
        VALUES(
          v_id, v_restaurant_id, v_name, NULLIF(p_payload->>'description',''),
          NULLIF(p_payload->>'category',''),
          COALESCE(NULLIF(btrim(p_payload->>'cuisine'),''),
            CASE WHEN position(' - ' in COALESCE(p_payload->>'category',''))>0
              THEN split_part(p_payload->>'category',' - ',1) ELSE 'Other' END),
          v_price, COALESCE((p_payload->>'tax_exempt')::boolean,false),
          NULLIF(p_payload->>'image_url',''), COALESCE((p_payload->>'is_active')::boolean,true),
          COALESCE(NULLIF(p_payload->>'sort_order','')::integer,
            (SELECT COALESCE(MAX(p2.sort_order),0)+1 FROM public.products p2 WHERE p2.restaurant_id=v_restaurant_id)), auth.uid(),
          COALESCE((p_payload->>'is_veg')::boolean,true),
          COALESCE((p_payload->>'price_review_required')::boolean,false),
          NULLIF(p_payload->>'price_source_note','')
        ) RETURNING to_jsonb(products) INTO v_record;
      ELSE
        UPDATE public.products p SET
          name=v_name,
          description=NULLIF(p_payload->>'description',''),
          category=NULLIF(p_payload->>'category',''),
          cuisine=COALESCE(NULLIF(btrim(p_payload->>'cuisine'),''),
            CASE WHEN position(' - ' in COALESCE(p_payload->>'category',''))>0
              THEN split_part(p_payload->>'category',' - ',1) ELSE p.cuisine END),
          price=v_price,
          tax_exempt=COALESCE((p_payload->>'tax_exempt')::boolean,false),
          image_url=NULLIF(p_payload->>'image_url',''),
          is_active=COALESCE((p_payload->>'is_active')::boolean,true),
          is_veg=COALESCE((p_payload->>'is_veg')::boolean,true),
          price_review_required=CASE
            WHEN p.price IS DISTINCT FROM v_price THEN false
            WHEN p_payload ? 'price_review_required' THEN COALESCE((p_payload->>'price_review_required')::boolean,false)
            ELSE p.price_review_required END,
          price_source_note=CASE
            WHEN p.price IS DISTINCT FROM v_price THEN 'Price reviewed in Admin product editor'
            WHEN p_payload ? 'price_source_note' THEN NULLIF(p_payload->>'price_source_note','')
            ELSE p.price_source_note END,
          updated_at=now()
        WHERE p.id=v_id AND p.restaurant_id=v_restaurant_id
        RETURNING to_jsonb(p) INTO v_record;
        IF v_record IS NULL THEN RAISE EXCEPTION 'Product not found.'; END IF;
      END IF;
    ELSE RAISE EXCEPTION 'Invalid product action.';
    END IF;

  ELSIF p_resource='cuisines' THEN
    IF p_action='delete' THEN
      DELETE FROM public.cuisines WHERE id=v_id AND restaurant_id=v_restaurant_id
      RETURNING to_jsonb(cuisines) INTO v_record;
      IF v_record IS NULL THEN RAISE EXCEPTION 'Category not found.'; END IF;
    ELSIF p_action IN ('insert','update') THEN
      v_name:=btrim(COALESCE(p_payload->>'name',''));
      IF v_name='' OR length(v_name)>100 THEN RAISE EXCEPTION 'Category name is required.'; END IF;
      IF p_action='insert' THEN
        INSERT INTO public.cuisines(id,restaurant_id,name,image_url,sort_order)
        VALUES(v_id,v_restaurant_id,v_name,NULLIF(p_payload->>'image_url',''),COALESCE(NULLIF(p_payload->>'sort_order','')::integer,0))
        RETURNING to_jsonb(cuisines) INTO v_record;
      ELSE
        UPDATE public.cuisines SET name=v_name,image_url=NULLIF(p_payload->>'image_url',''),sort_order=COALESCE(NULLIF(p_payload->>'sort_order','')::integer,0),updated_at=now()
        WHERE id=v_id AND restaurant_id=v_restaurant_id
        RETURNING to_jsonb(cuisines) INTO v_record;
        IF v_record IS NULL THEN RAISE EXCEPTION 'Category not found.'; END IF;
      END IF;
    ELSE RAISE EXCEPTION 'Invalid category action.';
    END IF;

  ELSIF p_resource='tables' THEN
    IF p_action='delete' THEN
      IF EXISTS (SELECT 1 FROM public.dining_sessions ds WHERE ds.table_id=v_id AND ds.restaurant_id=v_restaurant_id AND ds.status<>'closed') THEN
        RAISE EXCEPTION 'A table with an open session cannot be deactivated.';
      END IF;
      UPDATE public.tables SET is_active=false,updated_at=now()
      WHERE id=v_id AND restaurant_id=v_restaurant_id RETURNING to_jsonb(tables) INTO v_record;
      IF v_record IS NULL THEN RAISE EXCEPTION 'Table not found.'; END IF;
    ELSIF p_action IN ('insert','update') THEN
      v_table_no:=btrim(COALESCE(p_payload->>'table_no',''));
      v_capacity:=NULLIF(p_payload->>'capacity','')::integer;
      v_is_active:=COALESCE((p_payload->>'is_active')::boolean,true);
      IF v_table_no='' OR length(v_table_no)>30 OR v_capacity IS NULL OR v_capacity<1 OR v_capacity>100 THEN
        RAISE EXCEPTION 'Valid table number and capacity are required.';
      END IF;
      IF p_action='insert' THEN
        INSERT INTO public.tables(id,restaurant_id,table_no,capacity,is_active,qr_token,pin_salt)
        VALUES(v_id,v_restaurant_id,v_table_no,v_capacity,v_is_active,gen_random_uuid(),(floor(random()*2147483646)::integer+1))
        RETURNING to_jsonb(tables) INTO v_record;
      ELSE
        IF NOT v_is_active AND EXISTS (SELECT 1 FROM public.dining_sessions ds WHERE ds.table_id=v_id AND ds.restaurant_id=v_restaurant_id AND ds.status<>'closed') THEN
          RAISE EXCEPTION 'A table with an open session cannot be deactivated.';
        END IF;
        UPDATE public.tables SET table_no=v_table_no,capacity=v_capacity,is_active=v_is_active,updated_at=now()
        WHERE id=v_id AND restaurant_id=v_restaurant_id RETURNING to_jsonb(tables) INTO v_record;
        IF v_record IS NULL THEN RAISE EXCEPTION 'Table not found.'; END IF;
      END IF;
    ELSE RAISE EXCEPTION 'Invalid table action.';
    END IF;

  ELSIF p_resource='settings' THEN
    v_id:=v_restaurant_id;
    IF p_action NOT IN ('save','update','insert') THEN RAISE EXCEPTION 'Invalid settings action.'; END IF;
    v_name:=btrim(COALESCE(p_payload->>'restaurant_name',''));
    IF v_name='' OR length(v_name)>160 THEN RAISE EXCEPTION 'Restaurant name is required.'; END IF;
    IF COALESCE(NULLIF(p_payload->>'cgst_rate','')::numeric,0)<0 OR COALESCE(NULLIF(p_payload->>'cgst_rate','')::numeric,0)>100
       OR COALESCE(NULLIF(p_payload->>'sgst_rate','')::numeric,0)<0 OR COALESCE(NULLIF(p_payload->>'sgst_rate','')::numeric,0)>100 THEN
      RAISE EXCEPTION 'Tax rates must be between 0 and 100.';
    END IF;
    INSERT INTO public.app_settings(restaurant_id,restaurant_name,upi_id,cgst_rate,sgst_rate,currency_symbol,receipt_footer,gst_number,restaurant_address,daily_pin,updated_at,updated_by)
    VALUES(v_restaurant_id,v_name,COALESCE(p_payload->>'upi_id',''),COALESCE(NULLIF(p_payload->>'cgst_rate','')::numeric,0),COALESCE(NULLIF(p_payload->>'sgst_rate','')::numeric,0),
      COALESCE(NULLIF(p_payload->>'currency_symbol',''),(SELECT a.currency_symbol FROM public.app_settings a WHERE a.restaurant_id=v_restaurant_id LIMIT 1),'₹'),COALESCE(p_payload->>'receipt_footer','Thank you for dining with us!'),NULLIF(p_payload->>'gst_number',''),
      NULLIF(p_payload->>'restaurant_address',''),NULL,now(),auth.uid())
    ON CONFLICT (restaurant_id) DO UPDATE SET restaurant_name=EXCLUDED.restaurant_name,upi_id=EXCLUDED.upi_id,cgst_rate=EXCLUDED.cgst_rate,sgst_rate=EXCLUDED.sgst_rate,
      currency_symbol=EXCLUDED.currency_symbol,receipt_footer=EXCLUDED.receipt_footer,gst_number=EXCLUDED.gst_number,restaurant_address=EXCLUDED.restaurant_address,daily_pin=NULL,updated_at=now(),updated_by=auth.uid()
    RETURNING to_jsonb(app_settings) INTO v_record;
    UPDATE public.restaurants SET name=v_name,updated_at=now() WHERE id=v_restaurant_id;

  ELSIF p_resource='branding' THEN
    v_id:=v_restaurant_id;
    IF p_action NOT IN ('save','update') THEN RAISE EXCEPTION 'Invalid branding action.'; END IF;
    v_bg:=COALESCE(p_payload->>'background_color','#fcfbf7');
    v_fg:=COALESCE(p_payload->>'foreground_color','#122216');
    IF v_bg !~ '^#[0-9A-Fa-f]{6}$' OR v_fg !~ '^#[0-9A-Fa-f]{6}$' THEN RAISE EXCEPTION 'Brand colors must be six-digit hex values.'; END IF;
    IF NULLIF(p_payload->>'icon_url','') IS NOT NULL AND p_payload->>'icon_url' !~ '^https://' THEN RAISE EXCEPTION 'Restaurant icon URL must use HTTPS.'; END IF;
    IF NULLIF(p_payload->>'logo_url','') IS NOT NULL AND p_payload->>'logo_url' !~ '^https://' THEN RAISE EXCEPTION 'Restaurant logo URL must use HTTPS.'; END IF;
    UPDATE public.restaurants SET background_color=v_bg,foreground_color=v_fg,icon_url=NULLIF(p_payload->>'icon_url',''),logo_url=NULLIF(p_payload->>'logo_url',''),updated_at=now()
    WHERE id=v_restaurant_id RETURNING to_jsonb(restaurants) INTO v_record;
  END IF;

  PERFORM public._tableforge_audit_event(v_restaurant_id,'admin_resource_'||p_action,p_resource,v_id::text,NULL,NULL,v_record,jsonb_build_object('resource',p_resource,'action',p_action));
  RETURN jsonb_build_object('ok',true,'resource',p_resource,'id',v_id,'record',v_record);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_public_pos_data(p_table_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $function$
DECLARE
  v_table public.tables%ROWTYPE;
  v_settings jsonb;
  v_products jsonb;
  v_cuisines jsonb;
  v_restaurant public.restaurants%ROWTYPE;
BEGIN
  IF p_table_id IS NULL THEN RAISE EXCEPTION 'A valid table QR is required.'; END IF;
  SELECT t.* INTO v_table FROM public.tables t WHERE t.id=p_table_id AND t.is_active=true;
  IF v_table.id IS NULL THEN RAISE EXCEPTION 'Table not found or inactive.'; END IF;
  SELECT r.* INTO v_restaurant FROM public.restaurants r WHERE r.id=v_table.restaurant_id;
  IF v_restaurant.id IS NULL THEN RAISE EXCEPTION 'Restaurant not found.'; END IF;
  SELECT jsonb_build_object(
    'restaurant_id',a.restaurant_id,'restaurant_name',a.restaurant_name,
    'cgst_rate',a.cgst_rate,'sgst_rate',a.sgst_rate,'currency_symbol',a.currency_symbol,
    'receipt_footer',a.receipt_footer
  ) INTO v_settings FROM public.app_settings a WHERE a.restaurant_id=v_table.restaurant_id LIMIT 1;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',p.id,'name',p.name,'description',p.description,'category',p.category,'cuisine',p.cuisine,
    'price',p.price,'tax_exempt',p.tax_exempt,'image_url',p.image_url,
    'is_active',p.is_active,'sort_order',p.sort_order,'restaurant_id',p.restaurant_id,'is_veg',p.is_veg
  ) ORDER BY p.sort_order,p.name),'[]'::jsonb) INTO v_products
  FROM public.products p WHERE p.restaurant_id=v_table.restaurant_id AND p.is_active=true;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',c.id,'name',c.name,'image_url',c.image_url,'sort_order',c.sort_order,'restaurant_id',c.restaurant_id
  ) ORDER BY c.sort_order,c.name),'[]'::jsonb) INTO v_cuisines
  FROM public.cuisines c WHERE c.restaurant_id=v_table.restaurant_id;
  RETURN jsonb_build_object(
    'restaurant_id',v_restaurant.id,
    'restaurant',jsonb_build_object('id',v_restaurant.id,'name',v_restaurant.name,'slug',v_restaurant.slug,
      'icon_url',v_restaurant.icon_url,'logo_url',v_restaurant.logo_url,
      'background_color',v_restaurant.background_color,'foreground_color',v_restaurant.foreground_color),
    'settings',COALESCE(v_settings,'{}'::jsonb),
    'products',COALESCE(v_products,'[]'::jsonb),
    'tables',jsonb_build_array(jsonb_build_object('id',v_table.id,'table_no',v_table.table_no,'capacity',v_table.capacity,'is_active',v_table.is_active,'restaurant_id',v_table.restaurant_id)),
    'cuisines',COALESCE(v_cuisines,'[]'::jsonb)
  );
END;
$function$;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- Post-run checks: expected section counts and any prices that still need review.
SELECT cuisine, category, count(*) AS active_items
FROM public.products
WHERE restaurant_id='197ff1e2-dd53-47a4-a5d5-46b3896ac021'::uuid AND is_active=true
GROUP BY cuisine,category
ORDER BY CASE category
  WHEN 'Soups' THEN 1 WHEN 'Salads' THEN 2 WHEN 'Starters & Tandoor' THEN 3
  WHEN 'Platters & Sizzlers' THEN 4 WHEN 'Main Course' THEN 5 WHEN 'Breads & Rice' THEN 6
  WHEN 'Noodles & Fried Rice' THEN 7 WHEN 'Pasta, Pizza & Bakes' THEN 8
  WHEN 'Papad' THEN 9 WHEN 'Desserts' THEN 10 WHEN 'Beverages' THEN 11 ELSE 99 END,
  cuisine;

SELECT name, price, price_source_note
FROM public.products
WHERE restaurant_id='197ff1e2-dd53-47a4-a5d5-46b3896ac021'::uuid
  AND is_active=true AND price_review_required=true
ORDER BY category, name;
