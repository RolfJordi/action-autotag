const Regex  = require('./regex.js')
const fs  = require( 'fs')
const path  = require('path')

class Dockerfile extends Regex {
  constructor (root = null) {
    root = path.join(process.env.GITHUB_WORKSPACE, root)

    if (fs.statSync(root).isDirectory()) {
      root = path.join(root, 'Dockerfile')
    }

    super(root, /LABEL[\s\t]+version=[\t\s+]?[\"\']?([0-9\.]+)[\"\']?/i)
  }
}
