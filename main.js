const core = require('@actions/core')
const os  = require( 'os')
const gh = require('@actions/github')
const fs  = require( 'fs')
const path  = require('path')


// Get authenticated GitHub client (Ocktokit): https://github.com/actions/toolkit/tree/master/packages/github#usage
const github = new gh.GitHub(process.env.GITHUB_TOKEN || process.env.INPUT_GITHUB_TOKEN)
// Get owner and repo from context of payload that triggered the action
const { owner, repo } = gh.context.repo



class Tag {
  constructor (prefix, version, postfix) {
    this.prefix = prefix
    this.version = version
    this.postfix = postfix
    this._tags = null
    this._message = null
    this._exists = null
    this._sha = ''
    this._uri = ''
    this._ref = ''
  }

  get name () {
    return `${this.prefix.trim()}${this.version.trim()}${this.postfix.trim()}`
  }

  set message (value) {
    if (value && value.length > 0) {
      this._message = value
    }
  }

  get sha () {
    return this._sha || ''
  }

  get uri () {
    return this._uri || ''
  }

  get ref () {
    return this._ref || ''
  }

  get prerelease () {
    return /([0-9\.]{5}(-[\w\.0-9]+)?)/i.test(this.version)
  }

  get build () {
    return /([0-9\.]{5}(\+[\w\.0-9]+)?)/i.test(this.version)
  }

  async getMessage () {
    if (this._message !== null) {
      return this._message
    }

    try {
      let tags = await this.getTags()

      if (tags.length === 0) {
        return `Version ${this.version}`
      }

      const changelog = await github.repos.compareCommits({ owner, repo, base: tags.shift().name, head: 'master' })
      const tpl = (core.getInput('commit_message_template', { required: false }) || '').trim()

      return changelog.data.commits
        .map(
          (commit, i) => {
            if (tpl.length > 0) {
              return tpl
                .replace(/\{\{\s?(number)\s?\}\}/gi, i + 1)
                .replace(/\{\{\s?(message)\s?\}\}/gi, commit.commit.message)
                .replace(/\{\{\s?(author)\s?\}\}/gi, commit.hasOwnProperty('author') ? (commit.author.hasOwnProperty('login') ? commit.author.login : '') : '')
                .replace(/\{\{\s?(sha)\s?\}\}/gi, commit.sha)
                .trim() + '\n'
            } else {
              return `${i === 0 ? '\n' : ''}${i + 1}) ${commit.commit.message}${
                commit.hasOwnProperty('author')
                  ? commit.author.hasOwnProperty('login')
                    ? ' (' + commit.author.login + ')'
                    : ''
                  : ''
              }\n(SHA: ${commit.sha})\n`
            }
          })
        .join('\n')
    } catch (e) {
      core.warning('Failed to generate changelog from commits: ' + e.message + os.EOL)
      return `Version ${this.version}`
    }
  }

  async getTags () {
    if (this._tags !== null) {
      return this._tags.data
    }

    this._tags = await github.repos.listTags({ owner, repo, per_page: 100 })

    return this._tags.data
  }

  async exists () {
    if (this._exists !== null) {
      return this._exists
    }
    const currentTag = this.name
    const tags = await this.getTags()

    for (const tag of tags) {
      if (tag.name === currentTag) {
        this._exists = true
        return true
      }
    }

    this._exists = false
    return false
  }

  async push () {
    let tagexists = await this.exists()

    if (!tagexists) {
      // Create tag
      const newTag = await github.git.createTag({
        owner,
        repo,
        tag: this.name,
        message: await this.getMessage(),
        object: process.env.GITHUB_SHA,
        type: 'commit'
      })

      this._sha = newTag.data.sha
      core.warning(`Created new tag: ${newTag.data.tag}`)

      // Create reference
      let newReference

      try {
        newReference = await github.git.createRef({
          owner,
          repo,
          ref: `refs/tags/${newTag.data.tag}`,
          sha: newTag.data.sha
        })
      } catch (e) {
        core.warning({
          owner,
          repo,
          ref: `refs/tags/${newTag.data.tag}`,
          sha: newTag.data.sha
        })

        throw e
      }

      this._uri = newReference.data.url
      this._ref = newReference.data.ref

      core.warning(`Reference ${newReference.data.ref} available at ${newReference.data.url}` + os.EOL)
    } else {
      core.warning('Cannot push tag (it already exists).')
    }
  }
}



class Setup {
  static debug () {
    // Metadate for debugging
    core.debug(
      ` Available environment variables:\n -> ${Object.keys(process.env)
        .map(i => i + ' :: ' + process.env[i])
        .join('\n -> ')}`
    )

    const dir = fs
      .readdirSync(path.resolve(process.env.GITHUB_WORKSPACE), { withFileTypes: true })
      .map(entry => {
        return `${entry.isDirectory() ? '> ' : '  - '}${entry.name}`
      })
      .join('\n')

    core.debug(` Working Directory: ${process.env.GITHUB_WORKSPACE}:\n${dir}`)
  }

  static requireAnyEnv () {
    for (const arg of arguments) {
      if (!process.env.hasOwnProperty(arg)) {
        return
      }
    }

    throw new Error('At least one of the following environment variables is required: ' + Array.slice(arguments).join(', '))
  }
}


class Package {
  constructor (root = './') {
    root = path.join(process.env.GITHUB_WORKSPACE, root)

    if (fs.statSync(root).isDirectory()) {
      root = path.join(root, 'package.json')
    }

    if (!fs.existsSync(root)) {
      throw new Error(`package.json does not exist at ${root}.`)
    }

    this.root = root
    this.data = JSON.parse(fs.readFileSync(root))
  }

  get version () {
    return this.data.version
  }
}


class Regex {
  constructor (root = './', pattern) {
    root = path.resolve(root)

    if (fs.statSync(root).isDirectory()) {
      throw new Error(`${root} is a directory. The Regex tag identification strategy requires a file.`)
    }

    if (!fs.existsSync(root)) {
      throw new Error(`"${root}" does not exist.`)
    }

    this.content = fs.readFileSync(root).toString()

    let content = pattern.exec(this.content)
    if (!content) {
      this._version = null
      // throw new Error(`Could not find pattern matching "${pattern.toString()}" in "${root}".`)
    } else if (content.groups && content.groups.version) {
      this._version = content.groups.version
    } else {
      this._version = content[1]
    }
  }

  get version () {
    return this._version
  }

  get versionFound () {
    return this._version !== null
  }
}


async function run () {
  try {
    // Configure the default output
    core.setOutput('tagcreated', 'no')

    // Identify the tag parsing strategy
    const root = core.getInput('root', { required: false }) || core.getInput('package_root', { required: false }) || './'
    const strategy = (core.getInput('regex_pattern', { required: false }) || '').trim().length > 0 ? 'regex' : ((core.getInput('strategy', { required: false }) || 'package').trim().toLowerCase())


    // Extract the version number using the supplied strategy
    let version = core.getInput('root', { required: false })
    version = version === null || version.trim().length === 0 ? null : version
    const pattern = core.getInput('regex_pattern', { required: false })

    switch (strategy) {
      case 'package':
        // Extract using the package strategy (this is the default strategy)
        version = (new Package(root)).version
        break

      case 'regex':
        version = (new Regex(root, new RegExp(pattern, 'gim'))).version
        break

      default:
        core.setFailed(`"${strategy}" is not a recognized tagging strategy. Choose from: 'package' (package.json), 'docker' (uses Dockerfile), or 'regex' (JS-based RegExp).`)
        return
    }

    const msg = ` using the ${strategy} extraction${strategy === 'regex' ? ' with the /' + pattern + '/gim pattern.' : ''}.`

    if (!version) {
      throw new Error(`No version identified${msg}`)
    }

    core.warning(`Recognized "${version}"${msg}`)
    core.setOutput('version', version)
    core.debug(` Detected version ${version}`)

    // Configure a tag using the identified version
    const tag = new Tag(
      core.getInput('tag_prefix', { required: false }),
      version,
      core.getInput('tag_suffix', { required: false })
    )

    core.warning(`Attempting to create ${tag.name} tag.`)
    core.setOutput('tagrequested', tag.name)
    core.setOutput('prerelease', tag.prerelease ? 'yes' : 'no')
    core.setOutput('build', tag.build ? 'yes' : 'no')

    // Check for existance of tag and abort (short circuit) if it already exists.
    if (await tag.exists()) {
      core.warning(`"${tag.name}" tag already exists.` + os.EOL)
      core.setOutput('tagname', '')
      return
    }

    // The tag setter will autocorrect the message if necessary.
    tag.message = core.getInput('tag_message', { required: false }).trim()
    await tag.push()

    core.setOutput('tagname', tag.name)
    core.setOutput('tagsha', tag.sha)
    core.setOutput('taguri', tag.uri)
    core.setOutput('tagmessage', tag.message)
    core.setOutput('tagref', tag.ref)
    core.setOutput('tagcreated', 'yes')
  } catch (error) {
    core.warning(error.message)
    core.warning(error.stack)
    core.setOutput('tagname', '')
    core.setOutput('tagsha', '')
    core.setOutput('taguri', '')
    core.setOutput('tagmessage', '')
    core.setOutput('tagref', '')
    core.setOutput('tagcreated', 'no')
  }
}

run().then((result) => console.log(result))
