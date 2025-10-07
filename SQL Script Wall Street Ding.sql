-- ================================================
--  Maak database (pas naam aan indien nodig)
-- ================================================
CREATE DATABASE IF NOT EXISTS wallstreet_party
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE wallstreet_party;

-- ================================================
--  Drop oude tabel indien nodig
-- ================================================
DROP TABLE IF EXISTS drinks;

-- ================================================
--  Tabel definitie
-- ================================================
CREATE TABLE drinks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  price DECIMAL(6,2) NOT NULL,         -- huidige prijs
  base_price DECIMAL(6,2) NOT NULL,    -- startprijs
  min_price DECIMAL(6,2) NOT NULL,     -- ondergrens
  max_price DECIMAL(6,2) NOT NULL,     -- bovengrens
  price_points INT NOT NULL,           -- bv. 1.30 → 130
  expected_popularity DECIMAL(6,2) NOT NULL,-- percentage verwachting
  locked BOOLEAN DEFAULT 0,            -- 1 = vastgezet
  is_alcoholic BOOLEAN DEFAULT 0,       -- 1 = alcoholisch, 0 = niet-alcoholisch
  sold_interval INT DEFAULT 0,
  crash_next_interval BOOLEAN DEFAULT 0
);

-- ================================================
--  Initiele data
-- ================================================
INSERT INTO drinks (name, price, base_price, min_price, max_price, price_points, expected_popularity, locked, is_alcoholic) VALUES
/*('Plat water', 1.30, 1.30, 1.30, 1.30, 130, 0.00, 1, 0),*/
('Bier', 2.50, 2.50, 2.00, 3.50, 250, 2, 0, 1),
('Wijn', 3.50, 3.50, 3.00, 5.00, 350, 1, 0, 1),
('Desperado’s', 3.50, 3.50, 2.60, 4.50, 350, 1, 0, 1),
('Kasteelbier Rouge', 3.50, 3.50, 2.50, 4.50, 350, 1, 0, 1),
('Vodka Red Bull', 6.00, 6.00, 4.20, 7.50, 600, 1, 0, 1),
('Vodka Fanta/Sprite', 5.00, 5.00, 3.70, 6.50, 500, 1, 0, 1),
('Baco', 5.00, 5.00, 3.30, 6.50, 500, 1, 0, 1),
('Gin Tonic', 5.00, 5.00, 3.50, 6.50, 500, 1, 0, 1),
('Red Bull', 3.00, 3.00, 2.50, 4.00, 300, 1, 0, 0),
('Bruiswater', 1.80, 1.80, 1.30, 2.50, 180, 1, 0, 0),
('frisdrank',2.20,2.20,1.60,2.80,1,0,0);


-- =========================================
-- 4. TRIGGERS
-- =========================================
DELIMITER $$

-- Bij UPDATE: sync price en price_points, reset naar base_price als boven max
CREATE TRIGGER sync_price_points_before_update
BEFORE UPDATE ON drinks
FOR EACH ROW
BEGIN
    -- Sync price en price_points
    IF NEW.price != OLD.price THEN
        SET NEW.price_points = ROUND(NEW.price * 100);
    ELSE
        SET NEW.price = NEW.price_points / 100;
    END IF;

    -- Clamp & reset
    IF NEW.price < NEW.min_price THEN
        SET NEW.price = NEW.min_price;
    ELSEIF NEW.price > NEW.max_price THEN
        -- Reset naar base_price
        SET NEW.price = NEW.base_price;
    END IF;

    SET NEW.price_points = ROUND(NEW.price * 100);
END$$

-- Bij INSERT: sync price en points
CREATE TRIGGER sync_price_points_before_insert
BEFORE INSERT ON drinks
FOR EACH ROW
BEGIN
    SET NEW.price = NEW.price_points / 100;

    IF NEW.price < NEW.min_price THEN
        SET NEW.price = NEW.min_price;
    ELSEIF NEW.price > NEW.max_price THEN
        SET NEW.price = NEW.base_price;
    END IF;

    SET NEW.price_points = ROUND(NEW.price * 100);
END$$

DELIMITER ;

-- =========================================
-- 5. WACHTWOORDEN
-- =========================================
DROP TABLE IF EXISTS access_passwords;
CREATE TABLE access_passwords (
    id INT AUTO_INCREMENT PRIMARY KEY,
    password VARCHAR(100) NOT NULL
);

INSERT INTO access_passwords (password) VALUES ('6666');
