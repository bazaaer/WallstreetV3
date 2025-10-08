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

DROP TABLE IF EXISTS sales;
CREATE TABLE sales (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  drink_id INT NOT NULL,
  qty INT NOT NULL DEFAULT 1,
  ts TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sales_drink
    FOREIGN KEY (drink_id) REFERENCES drinks(id)
    ON UPDATE CASCADE ON DELETE RESTRICT
);

-- Helpful indexes for the rolling window queries
CREATE INDEX idx_sales_ts ON sales(ts);
CREATE INDEX idx_sales_drink_ts ON sales(drink_id, ts);

-- =========================================
-- 5. WACHTWOORDEN
-- =========================================
DROP TABLE IF EXISTS access_passwords;
CREATE TABLE access_passwords (
    id INT AUTO_INCREMENT PRIMARY KEY,
    password VARCHAR(100) NOT NULL
);

INSERT INTO access_passwords (password) VALUES ('6666');
