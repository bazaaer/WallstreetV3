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
  price DECIMAL(6,2) NOT NULL,
  base_price DECIMAL(6,2) NOT NULL,
  min_price DECIMAL(6,2) NOT NULL,
  max_price DECIMAL(6,2) NOT NULL,
  price_points INT NOT NULL,
  expected_popularity DECIMAL(6,3) NOT NULL,
  locked BOOLEAN DEFAULT 0,
  is_alcoholic BOOLEAN DEFAULT 0,
  sold_interval INT DEFAULT 0,
  crash_next_interval BOOLEAN DEFAULT 0,
  delta_max DECIMAL(4,2) DEFAULT 0.4,
  gamma DECIMAL(4,2) DEFAULT 0.4
);

INSERT INTO drinks (name, price, base_price, min_price, max_price, price_points, expected_popularity, locked, is_alcoholic, delta_max, gamma) VALUES
('Bier', 2.50, 2.50, 1.60, 3.00, 250, 0.55, 0, 1, 0.3, 0.4),
('Frisdrank', 2.20, 2.20, 1.60, 2.80, 220, 0.036, 0, 0, 0.4, 0.4),
('Spuitwater', 1.80, 1.80, 1.30, 2.50, 180, 0.004, 0, 0, 0.4, 0.4),
('Desperados', 3.50, 3.50, 2.60, 4.50, 350, 0.03, 0, 1, 0.4, 0.3),
('Rouge', 4.50, 4.50, 4.50, 4.50, 450, 0.11, 0, 1, 0.4, 0.3),
('Vodka Redbull', 6.00, 6.00, 4.20, 7.50, 600, 0.08, 0, 1, 0.4, 0.3),
('Vodka Fris', 5.00, 5.00, 3.70, 6.50, 500, 0.04, 0, 1, 0.4, 0.3),
('Gintonic', 6.50, 6.50, 6.50, 6.50, 650, 0.04, 0, 1, 0.4, 0.3),
('Baco', 5.00, 5.00, 3.30, 6.50, 500, 0.08, 0, 1, 0.4, 0.3),
('Wijn', 3.50, 3.50, 2.20, 4.00, 350, 0.024, 0, 1, 0.4, 0.3),
('Red Bull', 3.00, 3.00, 2.80, 4.50, 300, 0.006, 0, 0, 0.4, 0.4);


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
