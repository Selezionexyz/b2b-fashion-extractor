const puppeteer = require('puppeteer');
const express = require('express');
const Database = require('better-sqlite3');
const cron = require('node-cron');
const fs = require('fs').promises;

// Configuration
const CONFIG = {
  credentials: {
    username: process.env.B2B_USERNAME || 'votre_login',
    password: process.env.B2B_PASSWORD || 'votre_mdp'
  },
  extraction: {
    baseUrl: 'https://b2bfashion.online',
    loginUrl: 'https://b2bfashion.online/login',
    delay: 2000
  },
  api: {
    port: process.env.PORT || 3000
  }
};

// Base de données
class DatabaseManager {
  constructor() {
    this.db = null;
  }

  async init() {
  await fs.mkdir('./data', { recursive: true });
  this.db = new Database('./data/fashion_products.db');
  this.createTables();
  }

  createTables() {
    return new Promise((resolve, reject) => {
      const sql = `
        CREATE TABLE IF NOT EXISTS products (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          reference TEXT UNIQUE NOT NULL,
          name TEXT NOT NULL,
          brand TEXT,
          price REAL,
          description TEXT,
          images TEXT,
          url TEXT,
          last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `;
      this.db.exec(sql, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async saveProduct(product) {
    return new Promise((resolve, reject) => {
      const sql = `
        INSERT OR REPLACE INTO products (
          reference, name, brand, price, description, images, url, last_updated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `;
      this.db.run(sql, [
        product.reference,
        product.name,
        product.brand,
        product.price,
        product.description,
        JSON.stringify(product.images || []),
        product.url
      ], function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      });
    });
  }

  async getAllProducts() {
    return new Promise((resolve, reject) => {
      this.db.all('SELECT * FROM products ORDER BY last_updated DESC', (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }
}

// Extracteur
class B2BFashionExtractor {
  constructor(dbManager) {
    this.db = dbManager;
    this.browser = null;
    this.page = null;
  }

  async init() {
    this.browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    this.page = await this.browser.newPage();
    await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  }

  async login() {
    console.log('🔐 Connexion...');
    await this.page.goto(CONFIG.extraction.loginUrl);
    
    // Essayer différents sélecteurs pour le login
    const usernameSelectors = ['input[name="username"]', 'input[name="email"]', '#username', '#email'];
    const passwordSelectors = ['input[name="password"]', '#password'];
    
    let usernameField = null;
    for (const selector of usernameSelectors) {
      try {
        usernameField = await this.page.$(selector);
        if (usernameField) break;
      } catch (e) {}
    }
    
    if (usernameField) {
      await usernameField.type(CONFIG.credentials.username);
    }
    
    let passwordField = null;
    for (const selector of passwordSelectors) {
      try {
        passwordField = await this.page.$(selector);
        if (passwordField) break;
      } catch (e) {}
    }
    
    if (passwordField) {
      await passwordField.type(CONFIG.credentials.password);
      await passwordField.press('Enter');
    }
    
    await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
    console.log('✅ Connexion réussie');
  }

  async extractProducts() {
    console.log('🔍 Extraction des produits...');
    
    await this.page.goto(CONFIG.extraction.baseUrl + '/catalog');
    await this.page.waitForSelector('.product, .item, .card', { timeout: 10000 });
    
    const products = await this.page.evaluate(() => {
      const productElements = document.querySelectorAll('.product, .item, .card');
      const products = [];
      
      productElements.forEach((element, index) => {
        const nameEl = element.querySelector('h1, h2, h3, .title, .name');
        const priceEl = element.querySelector('.price, .cost, .amount');
        const imageEl = element.querySelector('img');
        const linkEl = element.querySelector('a') || element;
        
        const product = {
          reference: `AUTO_${Date.now()}_${index}`,
          name: nameEl ? nameEl.textContent.trim() : 'Produit',
