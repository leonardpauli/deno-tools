#!/usr/bin/env deno run --allow-read --allow-run=pbcopy --allow-env=TERM_PROGRAM --ext=ts

/*
answer style:
- only answer with ONE SINGLE code block, containing an iterative improvement of the entire solution
- no preable, no postamble
- feel free to think concisely in code comments
- add `// todo: ...` for future improvements (but code should always work as it is)
- top-down style, start with `const main = async ()=> {}`, that calls sub-routines for every line, then define those sub-routines after
- if any seem to be big, just mock it and add a todo
- ignore fixing any `// todo.later` comments

code style:
- use: single quotes, trailing commas, tabs, snake_case, `const my_fn = ()=> {}`
- use: named expressions vs magic numbers, terse logic (eg, `a && f()` vs if, etc)
- use: typescript type/interface declarations where it gives clarity
- use: early returns/continues
- avoid: semicolons, superfluous comments

problem:
- when working over chat/LLM, we often need to send the entire code project as a single text message
- it should start with some context, like the file structure, and then the code itself, formatted in code blocks
- but larger files may need to be cut short (they can ask for more if needed)
- and all non-relevant files should be omitted (like node_modules, from .gitignore, the .git folder, .DS_Store, package-lock.json, etc)
- it would be nice to see the copied tree structure with neat colors in the terminal window
- and then have it auto-copy the full message to the clipboard

notes:
- use cli lib to allow --per_file_byte_limit override
- implement a custom breadth-first tree walker to skip non-relevant files
- waker to be async, and update an object
- then print the tree with colors
*/


import { Command } from "https://deno.land/x/cliffy@v1.0.0-rc.4/command/mod.ts";

import * as ansi_escapes from "https://deno.land/x/ansi@1.0.1/mod.ts"
import * as ansi_colors from "https://deno.land/std@0.224.0/fmt/colors.ts"

import { join } from "https://deno.land/std@0.152.0/path/mod.ts"
import { readAll } from "https://deno.land/std@0.152.0/streams/conversion.ts"


const artificial_slowdown = 40

const config = {
	title: 'project2prompt',
	version: '0.1.0',
	description: 'Copies a project directory tree, inc code blocks, to the clipboard, for LLM friendly sharing.',
	per_file_byte_limit: 8192,
}

const main = async ()=> {
	const options = await handle_cli()
	const root = await single_node(options.directory)
	const ctx = tree_context_new()

	const { rows } = Deno.consoleSize()
	console.log('start')
	let written_lines = 0

	const status_runner: PeriodicRunner = {
		min_ms: 1000/30,
		runner: ()=> {
			const dim = ansi_colors.dim
			Deno.stdout.writeSync(new TextEncoder().encode(ansi_escapes.cursorMove(0, -written_lines)))
			Deno.stdout.writeSync(new TextEncoder().encode(ansi_escapes.eraseDown()))
			const text_status = Object.entries(ctx).map(([k, v])=> `${dim(k+':')} ${v}`).join(', ')
			const text = text_status + '\n' + render_tree(root, '', true)
			const lines_all = text.split('\n')
			const lines = lines_all.slice(0, rows-3)
			written_lines = lines.length
			console.log(lines.join('\n'))
		},
	}
	status_runner_start(status_runner)
	const tree_done = build_tree(root, ctx)
	await tree_done
	status_runner_stop(status_runner)
	const prompt = render_tree_prompt(root)
	await copy_to_clipboard(prompt)
}

interface Options {
	per_file_byte_limit: number
	directory: string,
}
const handle_cli = async (): Promise<Options> => {
	const { options, args } = await new Command()
		.name(config.title).version(config.version).description(config.description)
		.option('--per_file_byte_limit <per_file_byte_limit:integer>', `truncate larger files`, { default: config.per_file_byte_limit })
		.arguments('[directory:string]')
		.parse(Deno.args)
	
	return {
		per_file_byte_limit: options.perFileByteLimit,
		directory: args[0] || Deno.cwd(),
	}
}


// tree

interface TreeNode {
	path: string
	filename: string
	is_dir: boolean
	children?: TreeNode[]
	content?: string
	byte_size?: number
	content_is_trimmed?: boolean
	byte_size_total?: number
	parent?: TreeNode
}

interface TreeContext {
	processed: number,
	ignored: number,
	queued: number,
}

const single_node = async (path: string): Promise<TreeNode> => {
	artificial_slowdown && await delay(artificial_slowdown)
	const info = await Deno.lstat(path)
	const filename = path.split('/').pop() as string
	const is_dir = info.isDirectory
	const node: TreeNode = { path, filename, is_dir }
	!is_dir && (node.byte_size = info.size)
	if (!is_dir && is_relevant(node)) {
		const file = await Deno.open(path)
		const bytes = await readAll(file)
		file.close()
		const text = new TextDecoder().decode(bytes)
		node.content_is_trimmed = bytes.length > config.per_file_byte_limit
		node.content = node.content_is_trimmed?
			text.slice(0, config.per_file_byte_limit): text
	}
	return node
}

const tree_context_new = (): TreeContext => ({ processed: 0, ignored: 0, queued: 0 })

const build_tree = async (root: TreeNode, ctx: TreeContext): Promise<void> => {
	// todo: update ctx
	const queue = [root]	
	while (queue.length) {
		const node = queue.shift() as TreeNode
		ctx.queued = queue.length
		ctx.processed++
		if (!node.is_dir) continue

		const entries = await Deno.readDir(node.path)
		node.children = []
		for await (const entry of entries) {
			const child = await single_node(join(node.path, entry.name))
			if (!is_relevant(child)) {
				ctx.ignored++
				continue
			}
			child.parent = node
			node.children.push(child)
			if (child.is_dir) queue.push(child)
			tree_recompute_byte_size_total(node)
		}
		node.children.sort((a, b)=> a.path.localeCompare(b.path))
	}
}
const tree_recompute_byte_size_total = (node: TreeNode) => {
	node.byte_size_total = node.children?.reduce((acc, child)=> acc+(child.byte_size_total||child.byte_size||0), 0)
	node.parent && tree_recompute_byte_size_total(node.parent)
}

const render_tree = (node: TreeNode, prefix = '', color = false): string => {
	const green = color ? ansi_colors.dim : (s: string)=> s
	const branch = green('├── ')
	const branch_last = green('└── ')
	const pipe = green('│   ')
	const space = '    '

	const size_total = node.byte_size_total || node.byte_size || 0
	const size = size_total?green(` (${format_bytes(size_total)})`): ''
	let str = node.filename+(node.is_dir?'/':'')+size+'\n'
	const children = node.children
	children && children.forEach((child, i)=> {
		const last = i === children.length - 1
		const prefix_new = prefix + (last ? space : pipe)
		const branch_new = (last ? branch_last : branch)
		str += `${prefix}${branch_new}${render_tree(child, prefix_new, color)}`+'\n'
	})
	
	return str.slice(0,-1)
}

const render_tree_prompt = (root: TreeNode): string => {
	const tree = render_tree(root, '', false)
	const files = linearize_tree(root)
		.map(node => render_code_block(node, root))
		.filter(Boolean)
		.join('\n\n')
	return `${tree}\n\n\n${files}`
}

const render_code_block = (node: TreeNode, root: TreeNode): string | null => {
	if (!node.content) return null
	const path = node.path.slice(root.path.length + 1)
	const size = node.byte_size?` (${format_bytes(node.byte_size)})`: ''
	const trimmed = node.content_is_trimmed? ' (trimmed)': ''
	const code_block_marker = '``'+'`' // to avoid closing the code block
	const language = node.filename.split('.').pop() || ''
	return `${path}${size}${trimmed}\n${code_block_marker}${language}\n${node.content}\n${code_block_marker}`
}

const linearize_tree = (node: TreeNode): TreeNode[] => {
	const nodes: TreeNode[] = []
	const queue = [node]
	while (queue.length) {
		const current = queue.shift() as TreeNode
		nodes.push(current)
		if (current.children) {
			queue.push(...current.children)
		}
	}
	return nodes
}


const mac_ignores = ['.DS_Store']
const js_ignores = ['node_modules', 'package-lock.json', 'yarn.lock', 'deno.lock']
const editor_ignores = ['.vscode', '.swp']
const git_ignores = ['.git', '.gitignore']
const artifact_ignores = ['dist', 'build', 'out', 'target', 'bin', 'coverage', 'vendor']
const common_ignores = new Set([...mac_ignores, ...js_ignores, ...editor_ignores, ...git_ignores, ...artifact_ignores])

const is_relevant = (node: TreeNode): boolean => {
	const irrelevant = common_ignores
	return !irrelevant.has(node.filename)
}


// utils

const format_bytes = (bytes: number): string => {
	const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
	let i = 0
	while (bytes >= 1024) {
		bytes /= 1024
		i++
	}
	return `${bytes.toFixed(1)}${sizes[i]}`
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const copy_to_clipboard = async (text: string) => {
	const p = Deno.run({
		cmd: ['pbcopy'],
		stdin: 'piped',
	})
	await p.stdin.write(new TextEncoder().encode(text))
	p.stdin.close()
	await p.status()
}


// utils.runner

interface PeriodicRunner {
	min_ms: number
	runner: (runner: PeriodicRunner)=> void
	timer?: number
	stop?: boolean
}
const status_runner_start = (runner: PeriodicRunner) => {
	runner.timer && (clearTimeout(runner.timer), runner.timer = undefined)
	runner.stop = false
	const run = async ()=> {
		runner.timer = undefined
		if (runner.stop) return
		const start = performance.now()
		await runner.runner(runner)
		const elapsed = performance.now() - start
		const wait = Math.max(runner.min_ms - elapsed, 0)
		runner.timer = setTimeout(run, wait)
	}
	run()
}
const status_runner_stop = (runner: PeriodicRunner) => {
	runner.stop = true
	runner.timer && (clearTimeout(runner.timer), runner.timer = undefined)
}


// main

if (import.meta.main) main().catch(console.error)
