/// <reference path="../typings/node/node.d.ts" />
/// <reference path="../typings/chalk/chalk.d.ts" />
/// <reference path="../typings/lodash/lodash.d.ts" />
/// <reference path="../typings/fs-extra/fs-extra.d.ts" />
/// <reference path="../typings/commander/commander.d.ts" />
/// <reference path="../typings/circular-json/circular-json.d.ts" />

"use strict";

import {deserialize, deserializeAs, Deserializable} from "./serialize";
import {GithubUtil} from "./github_util";
import {
  GithubUser, Language, Repository, GithubEvent,
  RepositorySummary, LanguageSummary
} from "./github_model";
import {Profile} from "./profile";

import * as _ from "lodash";
import * as CircularJSON from "circular-json";
import * as fse from "fs-extra";
import {
  red as chalkRed, blue as chalkBlue, green as chalkGreen,
  yellow as chalkYellow, magenta as chalkMagenta, bold as chalkBold
} from "chalk";

let path = require("path");
let pretty = require("prettyjson");

/** generator.js exists in build/src */
const PROJECT_DIR = path.join(path.dirname(__dirname), "../");
const ENV_JSON = require(path.join(PROJECT_DIR, "env.json"));

const GENERATOR_VERSION = require(path.join(PROJECT_DIR, ENV_JSON.FILE.PACKAGE_JSON)).version;

const PROFILE_TEMPLATE_JSON = require(path.join(PROJECT_DIR, ENV_JSON.FILE.PROFILE_TEMPLATE_JSON));
const FILE_NAME_PROFILE_JSON = ENV_JSON.FILE.PROFILE_JSON;

export class OptionSetting {
  constructor(public specifiers: string, public description: string) {}
}

export class ProfileOptions {
  public static PROFILE_OPTION_SPECIFIER_LANGUAGE   = "-l, --language";
  public static PROFILE_OPTION_SPECIFIER_REPOSITORY = "-r, --repository";
  public static PROFILE_OPTION_SPECIFIER_ACTIVITY   = "-a, --activity";

  public static PROFILE_OPTION_LANGUAGE   =
    new OptionSetting(ProfileOptions.PROFILE_OPTION_SPECIFIER_LANGUAGE, "show language summary");
  public static PROFILE_OPTION_REPOSITORY =
    new OptionSetting(ProfileOptions.PROFILE_OPTION_SPECIFIER_REPOSITORY, "show repository summary");
  public static PROFILE_OPTION_ACTIVITY   =
    new OptionSetting(ProfileOptions.PROFILE_OPTION_SPECIFIER_ACTIVITY, "show activity summary");

  public static ALL_PROFILE_OPTIONS = [
    ProfileOptions.PROFILE_OPTION_LANGUAGE,
    ProfileOptions.PROFILE_OPTION_REPOSITORY,
    ProfileOptions.PROFILE_OPTION_ACTIVITY
  ];

  language: boolean;
  repository: boolean;
  activity: boolean;
}

export class CommandSetting {
  constructor(public specifiers: string,
              public description: string,
              public action: (...args: any[]) => void,
              public alias?: string) {}

  public static COMMAND_NAME_PROFILE = "profile";
  public static COMMAND_PROFILE = new CommandSetting(
    `${CommandSetting.COMMAND_NAME_PROFILE} <token> <user>`,
    "Create Github profile using the provided token for the user",
    function(token: string, user: string, options: ProfileOptions) {
      let confPath = getProfilePath();
      let prevProf = Profile.deserialize(Profile, readFileIfExist(confPath));

      createProfile(token, user, options)
        .then(currentProf => {

          /** concat and remove duplicated activities by filtering out using event_id */
          let allActs = currentProf.activities.concat(prevProf.activities).filter(a => !_.isEmpty(a));
          let uniqEventIds = new Set();
          let uniqActs = new Array<GithubEvent>();

          for (let i = 0; i < allActs.length; i++) {
            let act = allActs[i];

            if (!uniqEventIds.has(act.event_id)) {
              uniqEventIds.add(act.event_id);
              uniqActs.push(act);
            }
          }

          currentProf.activities = uniqActs;
          overwriteFile(confPath, currentProf);
        })
        .catch(err => {
          console.log(`${chalkRed("Cannot create profile\n")} ${chalkBold(path)}`);
          console.error(`\n${err.stack}`);
        });
    }
  );

  public static COMMAND_NAME_INIT = "init";
  public static COMMAND_INIT = new CommandSetting(
    `${CommandSetting.COMMAND_NAME_INIT} <repo>`,
    "Initialize `oh-my-github.json` database file",
    function(repo: string) {
      let confPath = getProfilePath();
      let template = JSON.parse(JSON.stringify(PROFILE_TEMPLATE_JSON));
      template._$meta.repository = repo;

      try {
        writeFileIfNotExist(confPath, template);
      } catch (err) {
        console.log(`${chalkRed("Cannot create file: ")} ${chalkBold(path)}`);
        console.error(`\n${err.stack}`);
      }
    }
  );

  public static ALL_COMMAND_SETTINGS = [
    CommandSetting.COMMAND_PROFILE,
    CommandSetting.COMMAND_INIT
  ];
}

async function createProfile(token: string,
                             user: string,
                             options: ProfileOptions): Promise<Profile> {
  let githubUser = await GithubUtil.getGithubUser(token, user);

  let langs = new Array<Language>();
  let repos = new Array<Repository>();
  let acts = new Array<GithubEvent>();

  if (options.repository) {
    repos = await GithubUtil.getUserRepositories(token, user);
  }

  if (options.language) {
    langs = await GithubUtil.getUserLanguages(token, user);
  }

  if (options.activity) {
    acts = await GithubUtil.getUserActivities(token, user);
  }

  // TODO: add repo name to language
  // TODO: add top language to repo

  printProfile(githubUser, langs, repos, acts);

  let profile = new Profile();
  profile.user = githubUser;
  profile.languages = langs;
  profile.repositories = repos;
  profile.activities = acts;

  return profile;
}

function printProfile(user: GithubUser,
                      langs: Array<Language>,
                      repos: Array<Repository>,
                      acts: Array<GithubEvent>): void {

  /** debug info */
  console.log(`\n[USER]`);
  console.log(pretty.render(user));

  console.log(`\n${chalkBlue("[LANGUAGE]")}`);

  if (!_.isEmpty(langs)) {
    let langMap = new Map<string, number>();

    langs.forEach(lang => {
      if (!langMap.has(lang.name)) langMap.set(lang.name, 0);

      let currentLine = langMap.get(lang.name);
      langMap.set(lang.name, lang.line + currentLine);
    });
    let langSummary = new LanguageSummary(user.login, langMap);
    console.log(pretty.render(langSummary));
  }

  console.log(`\n${chalkBlue("[REPOSITORY]")}`);
  if (!_.isEmpty(repos)) {
    let repoSummary = new RepositorySummary();
    repos.reduce((sum, repo) => {
      sum.repository_names.push(repo.name);
      sum.repository_count += 1;
      sum.watchers_count += repo.watchers_count;
      sum.stargazers_count += repo.stargazers_count;
      sum.forks_count += repo.forks_count;

      return sum;
    }, repoSummary);
    console.log(pretty.render(repoSummary));
  }

  console.log(`\n${chalkBlue("[ACTIVITY]")}`);

  if (!_.isEmpty(acts)) {
    console.log(`Activity Count: ${acts.length}`);
  }
}

/**
 * write file iff the file does not exist otherwise throw an error
 */
function writeFileIfNotExist(path: string, json: Object): void {
  fse.writeJsonSync(path, json, {flag: "wx"});
}

/**
 * overwrite file
 */
function overwriteFile(path: string, json: Object): void {
  fse.writeJsonSync(path, json, {flag: "w+"});
}

/**
 * read file iff the file exists otherwise throw an error
 */
function readFileIfExist(path: string): any {
  return fse.readJsonSync(path, {flag: "r"})
}

function getProfilePath(): string {
  return combinePathWithCwd(FILE_NAME_PROFILE_JSON);
}

function combinePathWithCwd(filePath: string) {
  return path.join(process.cwd(), filePath);
}

export class ParsedOption {
  @deserialize public flags: string;
  @deserialize public required: number;
  @deserialize public optional: number;
  @deserialize public bool: boolean;
  @deserialize public short: string;
  @deserialize public long: string;
  @deserialize public description: string;
}

export class ParsedCommand extends Deserializable {
  @deserializeAs("_name") public name: string;
  @deserializeAs("_description") public description: string;
  @deserializeAs(ParsedCommand) public commands: Array<ParsedCommand>;
  @deserializeAs(ParsedOption) public options: Array<ParsedOption>;
}

export class CommandFactory {
  public static create(argv: string[]): ParsedCommand {
    let parser = require("commander");

    parser
      .version(GENERATOR_VERSION);

    parser
      .command(CommandSetting.COMMAND_PROFILE.specifiers)
      .description(CommandSetting.COMMAND_PROFILE.description)
      .option(ProfileOptions.PROFILE_OPTION_LANGUAGE.specifiers, ProfileOptions.PROFILE_OPTION_LANGUAGE.description)
      .option(ProfileOptions.PROFILE_OPTION_REPOSITORY.specifiers, ProfileOptions.PROFILE_OPTION_REPOSITORY.description)
      .option(ProfileOptions.PROFILE_OPTION_ACTIVITY.specifiers, ProfileOptions.PROFILE_OPTION_ACTIVITY.description)
      .action(CommandSetting.COMMAND_PROFILE.action);

    parser
      .command(CommandSetting.COMMAND_INIT.specifiers)
      .description(CommandSetting.COMMAND_INIT.description)
      .action(CommandSetting.COMMAND_INIT.action);

    /** use circular-json to avoid cyclic references */
    let serialized = CircularJSON.stringify(parser.parse(argv));
    let circularDeserialized = CircularJSON.parse(serialized);
    let deserialized = ParsedCommand.deserialize(ParsedCommand, circularDeserialized);
    return deserialized;
  }
}
