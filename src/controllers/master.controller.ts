import type { Request, Response } from 'express';
import * as productService from '../services/product.service.js';
import * as categoryService from '../services/category.service.js';
import * as customerService from '../services/customer.service.js';
import type { ProductListQuery } from '../services/product.service.js';
import type { CustomerListQuery } from '../services/customer.service.js';
import { validated } from '../middleware/validate.js';
import { asInt } from '../utils/tx.js';

/* ------------------------------ products ------------------------------ */
export async function listProducts(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await productService.listProducts(validated<ProductListQuery>(res)));
}

export async function getProduct(req: Request, res: Response): Promise<void> {
  res.status(200).json(await productService.getProduct(asInt(req.params.id!, 'id')));
}

export async function createProduct(req: Request, res: Response): Promise<void> {
  res.status(201).json(await productService.createProduct(req.body));
}

export async function updateProduct(req: Request, res: Response): Promise<void> {
  res.status(200).json(await productService.updateProduct(asInt(req.params.id!, 'id'), req.body));
}

/** Soft delete: is_active=false, histori stok & ledger tetap utuh. */
export async function deleteProduct(req: Request, res: Response): Promise<void> {
  res.status(200).json(await productService.deactivateProduct(asInt(req.params.id!, 'id')));
}

/* ----------------------------- categories ----------------------------- */
export async function listCategories(_req: Request, res: Response): Promise<void> {
  const { active_only } = validated<{ active_only?: boolean }>(res);
  res.status(200).json(await categoryService.listCategories(active_only === true));
}

export async function createCategory(req: Request, res: Response): Promise<void> {
  const { name, type_id } = req.body as { name: string; type_id?: number | null };
  res.status(201).json(await categoryService.createCategory(name, type_id ?? null));
}

export async function updateCategory(req: Request, res: Response): Promise<void> {
  res.status(200).json(await categoryService.updateCategory(asInt(req.params.id!, 'id'), req.body));
}

export async function listProductTypes(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await categoryService.listProductTypes());
}

export async function createProductType(req: Request, res: Response): Promise<void> {
  res.status(201).json(await categoryService.createProductType((req.body as { name: string }).name));
}

/* ----------------------------- customers ----------------------------- */
export async function listCustomers(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await customerService.listCustomers(validated<CustomerListQuery>(res)));
}

export async function getCustomer(req: Request, res: Response): Promise<void> {
  res.status(200).json(await customerService.getCustomer(asInt(req.params.id!, 'id')));
}

export async function createCustomer(req: Request, res: Response): Promise<void> {
  res.status(201).json(await customerService.createCustomer(req.body));
}

export async function updateCustomer(req: Request, res: Response): Promise<void> {
  res.status(200).json(await customerService.updateCustomer(asInt(req.params.id!, 'id'), req.body));
}
