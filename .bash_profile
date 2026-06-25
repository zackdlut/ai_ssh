# .bash_profile

# Get the aliases and functions
if [ -f ~/.bashrc ]; then
	. ~/.bashrc
fi

# User specific environment and startup programs

### Environment display
if [ -f /imsgit/Tools/ims_gitcm/scripts_common/git-userSettings.sh ]; then . /imsgit/Tools/ims_gitcm/scripts_common/git-userSettings.sh; fi

git config --global user.name "Zack Zhang"
git config --global user.email "zack.zhang@nokia.com"


### Source global definitions
if [ -f /etc/bashrc ]; then . /etc/bashrc; fi

### User settings for Git compilation
if [ -f ~/.gitbashrc ]; then . ~/.gitbashrc; fi
